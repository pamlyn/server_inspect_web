"""自定义看板：配置规范化与"不允许提交SQL"的安全边界测试。"""

import errno
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_module
from modules.custom_dashboards import helpers as dash_helpers


class NormalizeBlockTest(unittest.TestCase):
    def test_忽略前端夹带的SQL与数据库配置(self):
        """区块只保留 script_id，SQL/库配置即使传进来也不会落库。"""
        block = dash_helpers.normalize_block({
            'type': 'table', 'title': '明细', 'script_id': 's1',
            'content': 'SELECT 1', 'database': 'mes', 'source_sql': 'DROP TABLE t',
        })
        for key in ('content', 'database', 'source_sql'):
            self.assertNotIn(key, block)
        self.assertEqual(block['script_id'], 's1')

    def test_非法类型回退为表格(self):
        self.assertEqual(dash_helpers.normalize_block({'type': 'iframe'})['type'], 'table')

    def test_布局被夹在合法范围内(self):
        layout = dash_helpers.normalize_block({'type': 'metric', 'layout': {'x': 99, 'w': 99, 'h': 99}})['layout']
        self.assertLessEqual(layout['w'], dash_helpers.MAX_BLOCK_WIDTH)
        self.assertLessEqual(layout['h'], dash_helpers.MAX_BLOCK_HEIGHT)
        self.assertLess(layout['x'], dash_helpers.GRID_COLUMNS)

    def test_刷新间隔下限(self):
        self.assertIsNotNone(dash_helpers.validate_refresh_seconds(5)[1])
        self.assertEqual(dash_helpers.validate_refresh_seconds(0)[0], 0)
        self.assertEqual(dash_helpers.validate_refresh_seconds(300)[0], 300)

    def test_区块配色只放行十六进制(self):
        # 颜色会拼进内联 style，非法值必须变成空串（跟随主题），不能原样带出去。
        block = dash_helpers.normalize_block({
            'type': 'metric',
            'title_color': '#FFF',
            'value_color': '#38bdf8',
            'accent_color': 'red; background:url(x)'
        })
        self.assertEqual(block['title_color'], '#fff')
        self.assertEqual(block['value_color'], '#38bdf8')
        self.assertEqual(block['accent_color'], '')

    def test_未填配色时跟随主题(self):
        block = dash_helpers.normalize_block({'type': 'metric'})
        self.assertEqual(
            (block['title_color'], block['value_color'], block['accent_color']), ('', '', ''))

    def test_背景主题只能取预设值(self):
        self.assertEqual(dash_helpers.normalize_dashboard({'name': 'A', 'theme': 'ocean'})['theme'], 'ocean')
        self.assertEqual(dash_helpers.normalize_dashboard({'name': 'A', 'theme': 'x'})['theme'], 'aurora')
        self.assertEqual(dash_helpers.normalize_dashboard({'name': 'A'})['theme'], 'aurora')

    def test_按列名取值兼容PG与MySQL行格式(self):
        columns = ['名称', '数量']
        self.assertEqual(dash_helpers.row_value(['甲', '12'], columns, '数量'), '12')
        self.assertEqual(dash_helpers.row_value({'名称': '甲', '数量': '12'}, columns, '数量'), '12')

    def test_字符串数值还原(self):
        self.assertEqual(dash_helpers.to_number('1,024'), 1024.0)
        self.assertEqual(dash_helpers.to_number('12.5%'), 12.5)
        self.assertIsNone(dash_helpers.to_number('未知'))


class BlockParamsTest(unittest.TestCase):
    """区块级变量覆盖值。"""

    def test_空值不落库(self):
        """留空表示"按脚本自己的动态规则算"，不能存成空串把默认值顶掉。"""
        params = dash_helpers.normalize_block({
            'type': 'table', 'script_id': 's1',
            'params': {'start': '2026-08-01', 'end': '', 'blank': '   '},
        })['params']
        self.assertEqual(params, {'start': '2026-08-01'})

    def test_只收标量(self):
        params = dash_helpers.normalize_block({
            'type': 'table', 'params': {'a': {'x': 1}, 'b': [1, 2], 'c': '3', 'd': 7},
        })['params']
        self.assertEqual(params, {'c': '3', 'd': '7'})

    def test_变量名与值都截断(self):
        params = dash_helpers.normalize_block({
            'type': 'table', 'params': {'n' * 100: 'v' * 300},
        })['params']
        name, value = list(params.items())[0]
        self.assertEqual(len(name), 60)
        self.assertEqual(len(value), 200)

    def test_变量个数有上限(self):
        raw = {f'v{i}': str(i) for i in range(50)}
        self.assertLessEqual(len(dash_helpers.normalize_block({'type': 'table', 'params': raw})['params']), 30)

    def test_填了值就固定住而留空按规则滚动(self):
        """这是 UI 要向用户交代的语义，用真实的解析函数钉住它。"""
        from modules.custom_scripts.helpers import get_variable_value
        variable = {'name': 'start', 'type': 'date', 'date_range_type': 'today'}
        import datetime
        today = datetime.datetime.now().strftime('%Y-%m-%d')
        self.assertEqual(get_variable_value(variable, {}), today)
        self.assertEqual(get_variable_value(variable, {'start': '2026-01-01'}), '2026-01-01')

    def test_渲染SQL时用覆盖值(self):
        variables = [{'name': 'start', 'type': 'date', 'date_range_type': 'today'}]
        sql = dash_helpers._render_sql("SELECT * FROM t WHERE d >= '#{start}'", variables, {'start': '2026-01-01'})
        self.assertIn('2026-01-01', sql)
        self.assertNotIn('#{start}', sql)


class DashboardApiTest(unittest.TestCase):
    def setUp(self):
        app_module.app.config['TESTING'] = True
        self.client = app_module.app.test_client()
        self._saved = list(dash_helpers.dashboards)
        dash_helpers.dashboards[:] = []
        # 测试不落盘。routes 用 `from helpers import save_dashboards` 持有自己的函数引用，
        # 必须 patch routes 里的那个名字，patch helpers 上的拦不住（否则测试会真写配置文件）。
        self._patch_save = patch('modules.custom_dashboards.routes.save_dashboards', lambda: None)
        self._patch_save.start()

    def tearDown(self):
        self._patch_save.stop()
        dash_helpers.dashboards[:] = self._saved

    def login(self, username='admin'):
        with self.client.session_transaction() as session:
            session['username'] = username
            session['logged_in'] = True

    def _run_with_perms(self, perms, func):
        """同时打两处 get_user_permissions：app.before_request 与装饰器各引用一份。"""
        with patch.object(app_module, 'get_user_permissions', lambda _u: set(perms)), \
             patch('modules.auth.helpers.get_user_permissions', lambda _u: set(perms)):
            return func()

    def test_提交带SQL的区块被拒绝(self):
        self.login()
        payload = {'name': '越权看板', 'blocks': [{'type': 'table', 'content': 'SELECT 1'}]}
        response = self._run_with_perms(
            ['custom_dashboard', 'custom_dashboard_manage'],
            lambda: self.client.post('/api/custom_dashboards', json=payload),
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('不能提交SQL', response.get_json().get('error', ''))

    def test_无配置权限不能新建看板(self):
        self.login('viewer')
        response = self._run_with_perms(
            ['custom_dashboard'],
            lambda: self.client.post('/api/custom_dashboards', json={'name': '只读用户建的'}),
        )
        self.assertEqual(response.status_code, 403)

    def test_无看板权限接口被拦截(self):
        self.login('other')
        response = self._run_with_perms(['inspection'], lambda: self.client.get('/api/custom_dashboards'))
        self.assertEqual(response.status_code, 403)

    def test_创建后可读取(self):
        self.login()
        perms = ['custom_dashboard', 'custom_dashboard_manage']
        payload = {'name': '生产日报', 'description': '早会看', 'refresh_seconds': 300,
                   'blocks': [{'type': 'metric', 'title': '报工数', 'script_id': 'abc'}]}
        created = self._run_with_perms(perms, lambda: self.client.post('/api/custom_dashboards', json=payload))
        self.assertEqual(created.status_code, 200)
        dashboard_id = created.get_json()['dashboard']['id']

        listed = self._run_with_perms(perms, lambda: self.client.get('/api/custom_dashboards'))
        self.assertEqual(listed.get_json()['dashboards'][0]['name'], '生产日报')

        detail = self._run_with_perms(perms, lambda: self.client.get(f'/api/custom_dashboards/{dashboard_id}'))
        self.assertEqual(detail.get_json()['dashboard']['blocks'][0]['script_id'], 'abc')


class ScriptCatalogFreshnessTest(unittest.TestCase):
    """回归：删除脚本后再新增，看板侧必须能看到新脚本。

    曾经 custom_scripts/routes.py 的删除分支重新绑定了模块全局名字，
    导致 routes 与 helpers 拿着两个不同的列表，看板模块永远读旧的那个。
    """

    def test_删除后新增的脚本看板仍可见(self):
        from modules.custom_scripts import helpers as cs_helpers
        from modules.custom_scripts import routes as cs_routes
        from modules.custom_dashboards import helpers as dash_helpers

        original = list(cs_helpers.custom_scripts)
        try:
            cs_helpers.custom_scripts[:] = [
                {'id': '1', 'name': '旧脚本', 'category': '生产', 'database': 'mes', 'content': 'select 1'},
                {'id': '2', 'name': '待删脚本', 'category': '生产', 'database': 'mes', 'content': 'select 2'},
            ]
            # 模拟删除分支：就地删除，不重新绑定名字。
            cs_routes.custom_scripts[:] = [s for s in cs_routes.custom_scripts if s['id'] != '2']
            # 删除后新增，走的是 routes 那个引用。
            cs_routes.custom_scripts.append(
                {'id': '3', 'name': '新脚本', 'category': '生产', 'database': 'mes', 'content': 'select 3'})

            self.assertIsNotNone(dash_helpers.find_script('3'), '看板应能找到删除后新增的脚本')
            self.assertIsNone(dash_helpers.find_script('2'), '已删除的脚本不应还在')
            self.assertIs(cs_routes.custom_scripts, cs_helpers.custom_scripts)
        finally:
            cs_helpers.custom_scripts[:] = original


class SaveDashboardsTest(unittest.TestCase):
    """落盘路径：单文件 bind mount 下 os.replace 会 EBUSY，必须退回就地写入。

    这条路径出问题的表现是「改了看板但重启后回到旧内容」，
    而且只在容器日志里留一行错误，界面上看不出来，所以必须有测试守着。
    """

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._file = os.path.join(self._tmp, 'custom_dashboards.json')
        self._patch = patch.object(dash_helpers, 'DASHBOARDS_FILE', self._file)
        self._patch.start()
        self._original = list(dash_helpers.dashboards)
        dash_helpers.dashboards[:] = [dash_helpers.normalize_dashboard({'name': '落盘验证'})]

    def tearDown(self):
        dash_helpers.dashboards[:] = self._original
        self._patch.stop()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _saved_names(self):
        with open(self._file, 'r', encoding='utf-8') as handle:
            return [item['name'] for item in json.load(handle)['dashboards']]

    def test_正常路径原子写入(self):
        dash_helpers.save_dashboards()
        self.assertEqual(self._saved_names(), ['落盘验证'])

    def test_单文件挂载下EBUSY退回就地写入(self):
        with open(self._file, 'w', encoding='utf-8') as handle:
            handle.write('{"dashboards": []}')
        busy = OSError(errno.EBUSY, 'Device or resource busy')
        with patch.object(dash_helpers.os, 'replace', side_effect=busy):
            dash_helpers.save_dashboards()
        self.assertEqual(self._saved_names(), ['落盘验证'])
        # 临时文件不能留下来，否则 config 目录会越攒越多 .tmp
        self.assertEqual([n for n in os.listdir(self._tmp) if n.endswith('.tmp')], [])

    def test_其他OSError不吞掉且不留临时文件(self):
        with patch.object(dash_helpers.os, 'replace', side_effect=OSError(errno.EACCES, 'denied')):
            dash_helpers.save_dashboards()  # 记录错误后返回，不抛给调用方
        self.assertEqual([n for n in os.listdir(self._tmp) if n.endswith('.tmp')], [])


class BlockStyleTest(unittest.TestCase):
    """区块样式字段：底色、对齐、字号、表格显示方式。

    这些值会被拼进 style 属性和 class 名，所以只能取白名单里的枚举，
    数值范围也必须夹住——填个 200 号字或者 -5 的透明度会把看板撑坏。
    """

    def test_样式字段有默认值(self):
        block = dash_helpers.normalize_block({'type': 'metric', 'script_id': 's1'})
        self.assertEqual(block['bg_preset'], 'theme')
        self.assertEqual(block['title_align'], 'left')
        self.assertEqual(block['value_align'], 'left')
        self.assertEqual(block['title_size'], 'md')
        self.assertEqual(block['value_size'], 'xl')
        self.assertEqual(block['bg_opacity'], 100)
        # 手输字号默认 0 = 用档位，不是 0 像素
        self.assertEqual(block['title_px'], 0)
        self.assertEqual(block['value_px'], 0)

    def test_非法枚举回落到默认(self):
        block = dash_helpers.normalize_block({
            'type': 'metric', 'script_id': 's1',
            'bg_preset': 'url(evil)', 'title_align': 'justify; color:red',
            'value_size': '200px', 'title_size': 'huge',
        })
        self.assertEqual(block['bg_preset'], 'theme')
        self.assertEqual(block['title_align'], 'left')
        self.assertEqual(block['value_size'], 'xl')
        self.assertEqual(block['title_size'], 'md')

    def test_合法枚举原样保留(self):
        block = dash_helpers.normalize_block({
            'type': 'metric', 'script_id': 's1',
            'bg_preset': 'glass', 'title_align': 'center', 'value_align': 'right',
            'title_size': 'lg', 'value_size': 'huge', 'bg_opacity': 60,
        })
        self.assertEqual(
            [block['bg_preset'], block['title_align'], block['value_align'],
             block['title_size'], block['value_size'], block['bg_opacity']],
            ['glass', 'center', 'right', 'lg', 'huge', 60])

    def test_透明度越界被夹住(self):
        low = dash_helpers.normalize_block({'type': 'metric', 'script_id': 's', 'bg_opacity': -20})
        high = dash_helpers.normalize_block({'type': 'metric', 'script_id': 's', 'bg_opacity': 999})
        self.assertEqual(low['bg_opacity'], 10)
        self.assertEqual(high['bg_opacity'], 100)

    def test_表格显示方式与字号(self):
        block = dash_helpers.normalize_block({
            'type': 'table', 'script_id': 's1',
            'table_mode': 'lazy', 'header_size': 'md', 'cell_size': 'xs', 'marquee_speed': 45,
        })
        self.assertEqual(block['table_mode'], 'lazy')
        self.assertEqual(block['header_size'], 'md')
        self.assertEqual(block['cell_size'], 'xs')
        self.assertEqual(block['marquee_speed'], 45)

    def test_非表格区块不带表格字段(self):
        block = dash_helpers.normalize_block({'type': 'metric', 'script_id': 's1', 'table_mode': 'lazy'})
        self.assertNotIn('table_mode', block)
        self.assertNotIn('header_px', block)

    def test_表头颜色走颜色白名单(self):
        ok = dash_helpers.normalize_block({'type': 'table', 'script_id': 's', 'header_color': '#22D3EE'})
        self.assertEqual(ok['header_color'], '#22d3ee')   # _color 统一转小写
        # 颜色会被拼进 style 属性，非法值必须清成空串（= 跟随主题），不能原样透出
        for bad in ['red;background:url(x)', 'rgb(1,2,3)', '#12', 'var(--x)']:
            block = dash_helpers.normalize_block({'type': 'table', 'script_id': 's', 'header_color': bad})
            self.assertEqual(block['header_color'], '', bad)

    def test_表格数据文字颜色走颜色白名单(self):
        ok = dash_helpers.normalize_block({'type': 'table', 'script_id': 's', 'cell_color': '#E2E8F0'})
        self.assertEqual(ok['cell_color'], '#e2e8f0')
        for bad in ['white;position:fixed', 'rgba(0,0,0,.5)', '#1', '#fff"onload="x']:
            block = dash_helpers.normalize_block({'type': 'table', 'script_id': 's', 'cell_color': bad})
            self.assertEqual(block['cell_color'], '', bad)

    def test_手输字号越界被夹住(self):
        block = dash_helpers.normalize_block({
            'type': 'table', 'script_id': 's',
            'title_px': 40, 'header_px': 9999, 'cell_px': -5,
        })
        self.assertEqual(block['title_px'], 40)
        self.assertEqual(block['header_px'], 200)
        self.assertEqual(block['cell_px'], 0)

    def test_手输字号非数字回落到零(self):
        # 0 的语义是"用档位"，所以垃圾输入落到 0 而不是某个具体像素值
        block = dash_helpers.normalize_block({
            'type': 'metric', 'script_id': 's', 'value_px': '80px;color:red',
        })
        self.assertEqual(block['value_px'], 0)

    def test_滚动速度越界被夹住(self):
        slow = dash_helpers.normalize_block({'type': 'table', 'script_id': 's', 'marquee_speed': 0})
        fast = dash_helpers.normalize_block({'type': 'table', 'script_id': 's', 'marquee_speed': 9999})
        self.assertEqual(slow['marquee_speed'], 4)
        self.assertEqual(fast['marquee_speed'], 400)

    def test_自动滚动不能把scrollTop读回来当累加基准(self):
        """浏览器把 scrollTop 吸附到整像素：每帧增量不到 0.5px 就归 0，
        读回来永远是 0 —— 表现就是「选了自动匀速滚动一动不动」。
        实测旧写法在 120Hz 屏上 3 秒走 0px（默认 30px/秒 只有 0.25px/帧），
        60Hz 上又因为 0.5px 进位成 1px 让速度翻倍（该走 90px 走了 180px），
        最低速 4px/秒 在任何刷新率下都死住。所以位置必须自己用浮点数记。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/js/custom_dashboard.js'), encoding='utf-8') as handle:
            js = handle.read()
        marquee = js.split('function bindMarquee', 1)[1].split('\n    function ', 1)[0]
        self.assertIn('pos += pxPerSec * dt', marquee, '位置要用浮点数累加')
        self.assertNotIn('wrap.scrollTop + pxPerSec', marquee, '不能把 scrollTop 读回来当累加基准')
        # 一圈长度要用 tbody 的一半，不能用 scrollHeight/2：后者含着 thead，
        # 每圈会早跳半个表头高度（实测 22px），表头字号越大跳得越明显。
        self.assertIn('body.offsetHeight / 2', marquee)
        # 标签页切走再切回来 now 会跳一大截，dt 不夹住会一帧滚过好几屏
        self.assertIn('Math.min((now - last) / 1000', marquee)
        # innerHTML/弹层刚显示时尺寸可能暂时为 0，必须延迟到布局完成后再判断是否可滚。
        self.assertIn('let waitFrames = 2', marquee)
        self.assertIn('requestAnimationFrame(start)', marquee)
        # 这是用户明确选择的数据展示方式，不是装饰动画，不能被系统减弱动画设置静默禁用。
        self.assertNotIn('prefers-reduced-motion', marquee)


class DashboardBackgroundTest(unittest.TestCase):
    """看板背景图字段。bg_image 会被拼进文件路径，是这组里最要紧的一条。"""

    def test_背景图id只放行32位十六进制(self):
        for bad in ['../../etc/passwd', 'abc', 'a' * 31, 'a' * 33, 'z' * 32,
                    '../' + 'a' * 29, 'a' * 32 + '/../x', '']:
            with self.subTest(bad=bad):
                self.assertEqual(
                    dash_helpers.normalize_dashboard({'name': 'x', 'bg_image': bad})['bg_image'], '')

    def test_合法背景图id保留并统一小写(self):
        board = dash_helpers.normalize_dashboard({'name': 'x', 'bg_image': 'AB' * 16})
        self.assertEqual(board['bg_image'], 'ab' * 16)

    def test_背景图铺法与压暗默认值(self):
        board = dash_helpers.normalize_dashboard({'name': 'x'})
        self.assertEqual(board['bg_fit'], 'cover')
        self.assertEqual(board['bg_dim'], 35)
        self.assertEqual(board['bg_blur'], 0)

    def test_压暗与模糊越界被夹住(self):
        board = dash_helpers.normalize_dashboard({'name': 'x', 'bg_dim': 200, 'bg_blur': -3})
        self.assertEqual(board['bg_dim'], 85)
        self.assertEqual(board['bg_blur'], 0)

    def test_新增主题在白名单内(self):
        for theme in ('nebula', 'cyber', 'daylight', 'sakura', 'bronze', 'verdant', 'frost'):
            with self.subTest(theme=theme):
                self.assertEqual(
                    dash_helpers.normalize_dashboard({'name': 'x', 'theme': theme})['theme'], theme)

    def test_每种风格的主题都不少于25套(self):
        """用户要求每组不低于 25 套。前端按 group 分组，这里按 CSS 类是否定义来数——
        主题少了一套 CSS，选择器上就是个空白块，光看白名单长度查不出来。"""
        css_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                'static', 'css', 'styles.css')
        with open(css_path, encoding='utf-8') as handle:
            defined = set(re.findall(r'^\.dash-theme-([a-z_0-9]+) \{', handle.read(), re.M))
        missing = [theme for theme in dash_helpers.ALLOWED_THEMES if theme not in defined]
        self.assertEqual(missing, [], '白名单里有主题没写 CSS，选出来是空白背景')
        light = set(dash_helpers.LIGHT_THEMES)
        self.assertGreaterEqual(len(light), 25)
        self.assertGreaterEqual(len(set(dash_helpers.ALLOWED_THEMES) - light), 50, '深色+渐变要各 25 套以上')
        self.assertTrue(light <= set(dash_helpers.ALLOWED_THEMES), '浅色主题必须同时在总白名单里')

    def test_舞台不再有网格层(self):
        """网格小格子被用户点名不好看，已去掉。模板和 CSS 都不该再出现，
        否则删一半会留个没样式的空 span（或没人用的死规则）。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for rel in ('static/css/styles.css', 'templates/dashboard_standalone.html',
                    'templates/partials/custom_dashboard_section.html'):
            with self.subTest(path=rel), open(os.path.join(root, rel), encoding='utf-8') as handle:
                # grid-area 是区块容器，同名前缀但不是这一层，不能一起删
                text = handle.read().replace('dash-stage-grid-area', '')
                self.assertNotIn('dash-stage-grid', text)

    def test_看板表头字号和颜色不被全局th规则压掉(self):
        """全局有条裸 `th { font-size:11px !important; color:#64748b !important }`（给后台表格用的）。
        !important 不看权重，所以看板表头的字号档和配色曾经全部失效——
        表现是「表头字号怎么选怎么填都不变、颜色怎么配都是那个灰」。
        看板侧的规则必须也标 !important 才压得住。这条测试盯着别被"顺手清理 !important"改回去。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/css/styles.css'), encoding='utf-8') as handle:
            css = handle.read()
        # 字号：只有这一条在给看板表头定字号
        self.assertIn('.dash-block .dash-table th { font-size:var(--block-head-px,var(--head-fs,15px)) !important;', css)
        # 颜色：四处消费 --block-head 的规则（普通/自定义底色/舞台上/舞台浅色主题）都得标上，
        # 漏一处就是「某些底色下配色不生效」这种最难查的半失效。
        # 只数规则里的，注释里提到这个变量名不算（注释也会命中裸 count）
        rules = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
        self.assertEqual(rules.count('var(--block-head,'), 4, '消费 --block-head 的规则数量变了，逐条确认都带 !important')
        for snippet in ('color:var(--block-head,var(--muted)) !important',
                        'color:var(--block-head,rgba(255,255,255,.82)) !important',
                        'color:var(--block-head,rgba(255,255,255,.8)) !important'):
            with self.subTest(rule=snippet):
                self.assertIn(snippet, css)

    def test_表头那一行不配底色只配字号和文字色(self):
        """表头底色的配置项已经撤掉：那条横带跟着这一块的底色走。
        为何撤：单独一套档位/取色器实测能生效，但每次都要跟块底色再对一遍深浅，
        配置的人反馈"怎么改都没用"，不如直接跟随。留下的只有字号和文字颜色。
        老配置里可能还存着 header_bg/header_bg_preset，normalize 时必须丢掉，不能报错。"""
        clean = dash_helpers.normalize_block({
            'id': 'b1', 'type': 'table', 'script_id': 's1',
            'header_color': '#ffcc00', 'header_size': 'xl', 'header_px': 22,
            'header_bg': '#3B0764', 'header_bg_preset': 'shadow'})
        self.assertEqual(clean['header_color'], '#ffcc00')
        self.assertEqual(clean['header_size'], 'xl')
        self.assertEqual(clean['header_px'], 22)
        for gone in ('header_bg', 'header_bg_preset'):
            with self.subTest(key=gone):
                self.assertNotIn(gone, clean, '表头底色不再是配置项，多余的键不能落库')
        self.assertFalse(hasattr(dash_helpers, 'ALLOWED_HEADER_BACKGROUNDS'))
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/css/styles.css'), encoding='utf-8') as handle:
            css = handle.read()
        for dead in ('--block-head-bg', 'is-headbg-'):
            with self.subTest(token=dead):
                self.assertNotIn(dead, css)
        # 不滚动时表头底色透明，才是真正"跟着这一块"：给个半透底就又成一条横带了。
        # 必须带 !important——后台皮肤 .style-midnight .dash-table th 也带 !important，
        # 不加就只有独立页透明、编辑器预览里还是一条深横带（预览和实际对不上）。
        for snippet in (
                '.dash-stage-grid-area .dash-block:not([class*="is-bg-"]) .dash-table th'
                ' { color:var(--block-head,rgba(255,255,255,.8)) !important; background:transparent !important;',
                '.dash-stage.is-light .dash-stage-grid-area .dash-block:not([class*="is-bg-"])'
                ' .dash-table th { color:var(--block-head,var(--muted)) !important; background:transparent !important;',
                # 选了底色预设（毛玻璃/深色玻璃/只留描边）的块，表头同样跟着块走
                '.dash-block.is-bg-glass .dash-table th,.dash-block.is-bg-outline .dash-table th,'
                '.dash-block.is-bg-shadow .dash-table th { color:var(--block-head,rgba(255,255,255,.82))'
                ' !important; background:transparent !important;'):
            with self.subTest(rule=snippet[:48]):
                self.assertIn(snippet, css)
        # 表头已经挪出滚动框（见 test_表头挪出滚动框所以行画不进表头），
        # 所以不再需要给吸顶表头兑不透明底色——那几条规则连带删掉了。
        rules = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
        self.assertNotIn('var(--st-1,#0f172a) 26%,#0b1220', rules)
        self.assertNotIn('.dash-table thead th', rules)
        with open(os.path.join(root, 'static/js/custom_dashboard.js'), encoding='utf-8') as handle:
            js = handle.read()
        for dead in ('header_bg', 'headbg', 'HEADER_BACKGROUNDS', '--block-head-bg'):
            with self.subTest(token=dead):
                self.assertNotIn(dead, js)
        # 字号和文字色的控件必须还在
        self.assertIn("sizeField('表头字号', index, 'header_size'", js)
        self.assertIn("key: 'header_color'", js)
        self.assertIn("['--block-head-px', clampInt(block.header_px, 0, 0, 200)]", js)

    def test_表头挪出滚动框所以行画不进表头(self):
        """表头单独一张表、摆在滚动框外面，不再用 position:sticky。
        为何这么改：吸顶表头和行在同一个滚动框里，行是从表头底下滚过去的——
        表头透明就能看见行穿过列名（用户原话"行数据会穿过列，不要这样"），
        给它兑不透明底色又是一条难看的实心横带（"只留描边"时尤其）。
        挪出滚动框后行被 overflow 裁掉，物理上进不到表头那一行，表头才能放心全透明。
        实测：滚到 7 个位置，行画出来的部分和表头带重叠 0.00px；
        把行涂成纯红截图，表头带内红像素 0，紧邻下方 28652。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/js/custom_dashboard.js'), encoding='utf-8') as handle:
            js = handle.read()
        # 表头必须在 dash-table-wrap 外面：四种模式的返回结构都是 box > (headbox, wrap)
        table = js.split('function renderTable', 1)[1].split('function syncTableColumns', 1)[0]
        self.assertNotIn('<thead>', table.split('function tableHead')[0],
                         '表头只能由 tableHead() 产出，不能再拼进滚动框里的表')
        for mode in ('is-mode-marquee', 'is-mode-'):
            with self.subTest(mode=mode):
                self.assertIn('dash-table-box %s' % mode, table)
        # 三处：marquee 一处、scroll/lazy 共用一处、paged 一处（四种模式三个分支）
        self.assertEqual(table.count('${head}'), 3, '每个分支都要在滚动框外面渲染表头')
        with open(os.path.join(root, 'static/css/styles.css'), encoding='utf-8') as handle:
            css = handle.read()
        rules = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
        # sticky 必须彻底去掉：留着就又回到"行从表头底下滚过去"
        self.assertNotIn('position:sticky', rules.split('.dash-table th')[1].split('}')[0])
        self.assertNotIn('.dash-table thead th', rules, '吸顶表头的那几条规则应该已经删掉')
        # 裁剪靠这两层：box 收边框、wrap 只滚
        self.assertIn('.dash-table-box { border:1px solid var(--line); border-radius:9px; overflow:hidden; }', css)
        self.assertIn('.dash-table-wrap { max-height:288px; overflow:auto; }', css)
        self.assertIn('.dash-table-headbox,.dash-table-head,.dash-table-head thead,.dash-table-head th { background:transparent !important; }', css,
                      '全局 thead/th 底色不能覆盖看板主题，表头应直接透出区块底色')

    def test_滚动加载首屏必须撑出可滚距离(self):
        """可视高度按"每行 33px"折算，但真实行高跟着字号变：表格文字选「很小」时一行只有 27px，
        pageSize 行加起来比可视高度还矮 → 不溢出 → 滚不动 → scroll 事件永不触发 →
        选了滚动加载却一行都不追加（实测 cell=xs 时 12 行/20 行的可滚距离都是 0）。
        所以绑完监听要先补几批到真的能滚为止。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/js/custom_dashboard.js'), encoding='utf-8') as handle:
            js = handle.read()
        fill = js.split('function fillUntilScrollable', 1)[1].split('\n    /**', 1)[0]
        self.assertIn('wrap.scrollHeight - wrap.clientHeight > 40', fill, '补到有可滚距离为止')
        self.assertIn('appendNextBatch(wrap, cache)', fill)
        self.assertIn('guard < 20', fill, '要有上限，行特别矮时别把整份数据一次灌进来')
        bind = js.split('function bindTableScroll', 1)[1].split('\n    /*', 1)[0]
        self.assertIn('fillUntilScrollable(wrap)', bind, '绑完监听必须立刻补，否则监听一辈子不触发')
        self.assertIn("querySelectorAll('.dash-table-box').forEach(syncTableColumns)", bind,
                      '所有模式都要对齐列宽，不只是可滚的')

    def test_两张表的列宽要量完写死(self):
        """表头挪出滚动框后是两张独立的表，各自按自己内容分配列宽，不对齐就是列名和数据错位。
        必须量完写进 colgroup 并切 table-layout:fixed——不切的话浏览器仍按内容微调，白量一遍。
        实测 8 列 × 4 种模式 × 两种字号，列左边缘最大错位 0.0px。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/js/custom_dashboard.js'), encoding='utf-8') as handle:
            js = handle.read()
        sync = js.split('function syncTableColumns', 1)[1].split('\n    /* lazy', 1)[0]
        self.assertIn("tableLayout = 'auto'", sync, '量之前要先回到 auto，否则量到的是上次写死的宽度')
        self.assertIn("tableLayout = 'fixed'", sync)
        self.assertIn('<colgroup>', sync)
        self.assertIn('Math.max(', sync, '取表头/数据两边的较大值，免得列名被挤到换行')
        self.assertIn('minWidth', sync, '装不下时两张表要一起横向溢出，不能各自被压缩')
        self.assertIn('headBox.scrollLeft = wrap.scrollLeft', sync, '横向滚动时表头要跟着走')

    def test_配色色板够用且按整行排(self):
        """色板原来只有 12 个、全是明亮色，配"底色"根本没有能压住文字的深色可选。
        扩到 36 个（中性/明亮/深色三行）。数量必须是 12 的倍数——
        .dash-swatch-row 是 12 列网格，不是倍数就会在最后一行留半排空格。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/js/custom_dashboard.js'), encoding='utf-8') as handle:
            js = handle.read()
        block = js.split('const COLOR_SWATCHES = [', 1)[1].split(']', 1)[0]
        colors = re.findall(r'#[0-9a-f]{6}', block)
        self.assertEqual(len(colors), 36)
        self.assertEqual(len(colors) % 12, 0, '色板数量要是 12 的倍数，对齐 dash-swatch-row 的 12 列')
        self.assertEqual(len(set(colors)), len(colors), '色板里有重复颜色')
        with open(os.path.join(root, 'static/css/styles.css'), encoding='utf-8') as handle:
            css = handle.read()
        self.assertIn('.dash-swatch-row { display:grid; grid-template-columns:repeat(12,1fr);', css)
        # 深色那一行是重点：配底色时浅色压不住文字
        for dark in ('#0f172a', '#1e293b', '#b91c1c', '#4338ca'):
            with self.subTest(color=dark):
                self.assertIn(dark, colors)

    def test_看板名称样式字段过白名单(self):
        """看板名称的字号/颜色/位置会被拼进 class 和 style，非法值必须回落而不是原样落库。"""
        clean = dash_helpers.normalize_dashboard({
            'name': 'x', 'name_size': 'xxl', 'name_px': 44,
            'name_color': '#ff0000', 'name_align': 'center'})
        self.assertEqual(
            [clean['name_size'], clean['name_px'], clean['name_color'], clean['name_align']],
            ['xxl', 44, '#ff0000', 'center'])
        # 带引号/分号的值如果原样输出就能从 class、style 里逃出去
        dirty = dash_helpers.normalize_dashboard({
            'name': 'x', 'name_size': 'xxl" onload=1', 'name_px': 9999,
            'name_color': 'red;background:url(x)', 'name_align': 'middle'})
        self.assertEqual(
            [dirty['name_size'], dirty['name_px'], dirty['name_color'], dirty['name_align']],
            ['md', 200, '', 'left'])
        blank = dash_helpers.normalize_dashboard({'name': 'x'})
        self.assertEqual(
            [blank['name_size'], blank['name_px'], blank['name_color'], blank['name_align']],
            ['md', 0, '', 'left'])

    def test_名称配色的类名不与区块配色撞名(self):
        """dash-color-row 是区块配色 colorPicker() 在用的容器，本来没有 CSS 规则（纯 block）。
        给它加 display:flex 会把每个区块配色字段变成横排——现象是整组挤成一行、
        每个字竖着排一列。看板名称那组必须用自己的类名。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/css/styles.css'), encoding='utf-8') as handle:
            css = handle.read()
        # 撞名的两个类名：CSS 里不能给它们定规则（JS 生成的那些结构依赖它们保持默认布局）
        for name in ('.dash-color-row {', '.dash-color-chip'):
            with self.subTest(name=name):
                if name == '.dash-color-row {':
                    self.assertNotIn(name, css, 'dash-color-row 被加了规则，会破坏区块配色的排版')
        # 名称那组用的是带 name 前缀的类名
        self.assertIn('.dash-name-color-row { display:flex;', css)
        self.assertIn('.dash-name-color-chip {', css)
        with open(os.path.join(root, 'templates/partials/custom_dashboard_section.html'), encoding='utf-8') as handle:
            tpl = handle.read()
        self.assertIn('dash-name-color-row', tpl)
        # 模板里也不能再出现裸的 dash-color-row / dash-color-chip（那是 JS 侧的类名）
        self.assertNotIn('class="dash-color-row"', tpl)

    def test_名称默认档不定义字号变量(self):
        """md 是默认档，故意不给它写 --stage-name-fs：留空才能让窄屏那条 21px 规则继续管事。
        一旦给 md 写死 27px，手机/竖屏上就永远是 27px 了。"""
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(root, 'static/css/styles.css'), encoding='utf-8') as handle:
            css = handle.read()
        self.assertNotIn('.dash-stage.is-name-md', css)
        for size in ('xs', 'sm', 'lg', 'xl', 'xxl'):
            with self.subTest(size=size):
                self.assertIn('.dash-stage.is-name-%s { --stage-name-fs:' % size, css)
        # 浅色主题和窄屏这两条覆盖都得给用户配的值让位，否则配了不生效
        self.assertIn('.dash-stage.is-light .dash-stage-title { color:var(--stage-name-color,var(--st-ink))', css)
        self.assertIn('.dash-stage-title { font-size:var(--stage-name-px,var(--stage-name-fs,21px)); }', css)


class AssetStoreTest(unittest.TestCase):
    """背景图上传：按文件头判类型 + 大小上限 + 服务端生成文件名。

    这三条是这个功能唯一的攻击面：能往服务器写文件的口子，
    放宽任何一条都等于给了任意文件写入或者把盘写满的能力。
    """

    def setUp(self):
        from modules.custom_dashboards import assets as assets_mod
        self.assets = assets_mod
        self._tmp = tempfile.mkdtemp()
        self._old_dir, self._old_index = assets_mod.ASSETS_DIR, assets_mod.INDEX_FILE
        assets_mod.ASSETS_DIR = self._tmp
        assets_mod.INDEX_FILE = os.path.join(self._tmp, 'index.json')

    def tearDown(self):
        self.assets.ASSETS_DIR, self.assets.INDEX_FILE = self._old_dir, self._old_index
        shutil.rmtree(self._tmp, ignore_errors=True)

    @staticmethod
    def _png(size=64):
        return io.BytesIO(b'\x89PNG\r\n\x1a\n' + b'\x00' * size)

    def test_合法png落盘且文件名是服务端生成的(self):
        asset, error = self.assets.save_asset(self._png(), '底图.png', 'admin')
        self.assertIsNone(error)
        self.assertRegex(asset['id'], r'^[0-9a-f]{32}$')
        self.assertEqual(asset['ext'], 'png')
        self.assertTrue(os.path.exists(self.assets.asset_path(asset)))

    def test_伪装成图片的文件被拒且不落盘(self):
        asset, error = self.assets.save_asset(io.BytesIO(b'<?php system($_GET[0]); ?>'), 'x.png', 'admin')
        self.assertIsNone(asset)
        self.assertIn('只支持', error)
        # 类型不对时磁盘上不该留任何东西
        self.assertEqual([n for n in os.listdir(self._tmp) if not n.endswith('.json')], [])

    def test_上传名里的路径穿越不影响落盘位置(self):
        asset, error = self.assets.save_asset(self._png(), '../../../../etc/passwd', 'admin')
        self.assertIsNone(error)
        self.assertEqual(os.path.dirname(self.assets.asset_path(asset)), self._tmp)
        self.assertEqual(os.listdir(self._tmp).count(f"{asset['id']}.png"), 1)

    def test_超过大小上限被拒且删掉半个文件(self):
        self.assets.MAX_ASSET_BYTES, old = 1024, self.assets.MAX_ASSET_BYTES
        try:
            asset, error = self.assets.save_asset(self._png(4096), '大图.png', 'admin')
        finally:
            self.assets.MAX_ASSET_BYTES = old
        self.assertIsNone(asset)
        self.assertIn('不能超过', error)
        self.assertEqual([n for n in os.listdir(self._tmp) if n.endswith('.png')], [])

    def test_mp4和webm按视频落盘(self):
        # MP4 的 ftyp 在第 5~8 字节，不在开头，所以要单独覆盖一次。
        mp4, error = self.assets.save_asset(io.BytesIO(b'\x00\x00\x00\x20ftypisom' + b'\x00' * 64), 'a.mp4', 'admin')
        self.assertIsNone(error)
        self.assertEqual(mp4['ext'], 'mp4')
        self.assertTrue(self.assets.is_video(mp4['ext']))
        webm, error = self.assets.save_asset(io.BytesIO(b'\x1aE\xdf\xa3' + b'\x00' * 64), 'a.webm', 'admin')
        self.assertIsNone(error)
        self.assertEqual(webm['ext'], 'webm')
        self.assertTrue(self.assets.is_video(webm['ext']))
        self.assertFalse(self.assets.is_video('png'))

    def test_视频走单独的大小上限(self):
        # 视频上限比图片高：拿图片的上限卡视频等于视频不可用。
        self.assertGreater(self.assets.max_bytes_for('mp4'), self.assets.max_bytes_for('png'))
        self.assets.MAX_VIDEO_BYTES, old = 1024, self.assets.MAX_VIDEO_BYTES
        try:
            asset, error = self.assets.save_asset(io.BytesIO(b'\x00\x00\x00\x20ftypisom' + b'\x00' * 4096), 'big.mp4', 'admin')
        finally:
            self.assets.MAX_VIDEO_BYTES = old
        self.assertIsNone(asset)
        self.assertIn('视频不能超过', error)
        self.assertEqual([n for n in os.listdir(self._tmp) if n.endswith('.mp4')], [])

    def test_视频mime按扩展名给对(self):
        self.assertEqual(self.assets.mime_for('mp4'), 'video/mp4')
        self.assertEqual(self.assets.mime_for('webm'), 'video/webm')

    def test_空文件被拒(self):
        asset, error = self.assets.save_asset(io.BytesIO(b''), 'x.png', 'admin')
        self.assertIsNone(asset)
        self.assertIn('空', error)

    def test_列表按时间倒序并可删除(self):
        first, _ = self.assets.save_asset(self._png(), 'a.png', 'admin')
        self.assertEqual(len(self.assets.list_assets()), 1)
        ok, error = self.assets.delete_asset(first['id'])
        self.assertTrue(ok, error)
        self.assertEqual(self.assets.list_assets(), [])
        self.assertFalse(os.path.exists(os.path.join(self._tmp, f"{first['id']}.png")))

    def test_被看板引用的图不允许删除(self):
        asset, _ = self.assets.save_asset(self._png(), 'a.png', 'admin')
        dash_helpers.dashboards[:] = [dash_helpers.normalize_dashboard(
            {'name': '在用看板', 'bg_image': asset['id']})]
        try:
            ok, error = self.assets.delete_asset(asset['id'])
        finally:
            dash_helpers.dashboards[:] = []
        self.assertFalse(ok)
        self.assertIn('在用看板', error)
        # 拒绝删除时文件必须还在，否则看板背景会变成 404
        self.assertTrue(os.path.exists(self.assets.asset_path(asset)))

    def test_张数上限(self):
        self.assets.MAX_ASSETS, old = 2, self.assets.MAX_ASSETS
        try:
            self.assets.save_asset(self._png(), 'a', 'admin')
            self.assets.save_asset(self._png(), 'b', 'admin')
            asset, error = self.assets.save_asset(self._png(), 'c', 'admin')
        finally:
            self.assets.MAX_ASSETS = old
        self.assertIsNone(asset)
        self.assertIn('上限', error)


class PublicDashboardTest(unittest.TestCase):
    """免登录看板：只有勾了 public 的那一个对匿名放开，其余照旧要登录。"""

    def setUp(self):
        self.client = app_module.app.test_client()
        self._saved = list(dash_helpers.dashboards)
        dash_helpers.dashboards[:] = [
            dash_helpers.normalize_dashboard({
                'id': 'pub1', 'name': '公开看板', 'public': True, 'owner': 'admin', 'blocks': [],
                'bg_image': 'a' * 32,
            }),
            dash_helpers.normalize_dashboard({
                'id': 'priv1', 'name': '内部看板', 'public': False, 'owner': 'admin', 'blocks': [],
                'bg_image': 'b' * 32,
            }),
        ]

    def tearDown(self):
        dash_helpers.dashboards[:] = self._saved

    def test_public默认关且只认真正的True(self):
        self.assertFalse(dash_helpers.normalize_dashboard({'name': 'x'})['public'])
        # 字符串 'false'/'true' 都不算开：只认布尔 True，避免 JSON 传串就把口子打开。
        for value in ['false', 'true', 1, 0, None, 'yes']:
            self.assertFalse(dash_helpers.normalize_dashboard({'name': 'x', 'public': value})['public'], value)
        self.assertTrue(dash_helpers.normalize_dashboard({'name': 'x', 'public': True})['public'])

    def test_匿名能打开公开看板页但私有看板跳登录(self):
        self.assertEqual(self.client.get('/dashboard/pub1').status_code, 200)
        response = self.client.get('/dashboard/priv1')
        self.assertEqual(response.status_code, 302)
        self.assertIn('/login', response.headers['Location'])

    def test_匿名读配置与执行只对公开看板放开(self):
        self.assertEqual(self.client.get('/api/custom_dashboards/pub1').status_code, 200)
        self.assertEqual(self.client.get('/api/custom_dashboards/priv1').status_code, 401)
        self.assertEqual(self.client.post('/api/custom_dashboards/pub1/execute').status_code, 200)
        self.assertEqual(self.client.post('/api/custom_dashboards/priv1/execute').status_code, 401)

    def test_匿名读配置不回owner(self):
        # owner 是账号名，不该顺着公开接口漏给匿名访客。
        payload = self.client.get('/api/custom_dashboards/pub1').get_json()
        self.assertNotIn('owner', payload['dashboard'])

    def test_匿名不能改删公开看板(self):
        self.assertEqual(self.client.put('/api/custom_dashboards/pub1', json={'name': '改'}).status_code, 403)
        self.assertEqual(self.client.delete('/api/custom_dashboards/pub1').status_code, 403)
        # 列表接口不因为有公开看板就对匿名开放
        self.assertEqual(self.client.get('/api/custom_dashboards').status_code, 401)

    def test_匿名只能取公开看板引用的背景素材(self):
        # 公开看板的背景要能免登录取到，否则页面开了但背景是裂的；
        # 私有看板的背景、以及没被任何公开看板引用的素材，仍然要登录。
        self.assertEqual(self.client.get(f"/api/custom_dashboards/assets/{'a' * 32}/raw").status_code, 404)
        self.assertEqual(self.client.get(f"/api/custom_dashboards/assets/{'b' * 32}/raw").status_code, 401)
        self.assertEqual(self.client.get(f"/api/custom_dashboards/assets/{'c' * 32}/raw").status_code, 401)

    def test_owner取session不取提交内容(self):
        # owner 决定免登录时按谁的权限跑脚本，能被提交方指定就等于可以借权限。
        with patch.object(app_module.app, 'test_client', app_module.app.test_client):
            client = app_module.app.test_client()
            with client.session_transaction() as session:
                session['username'] = 'admin'
            with patch('modules.custom_dashboards.routes.save_dashboards'), \
                 patch('modules.custom_dashboards.routes._can_manage', return_value=True), \
                 patch('modules.auth.helpers.get_user_permissions',
                       return_value={'custom_dashboard', 'custom_dashboard_manage'}):
                response = client.post('/api/custom_dashboards',
                                       json={'name': '借权限', 'owner': 'someone_else', 'blocks': []})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['dashboard']['owner'], 'admin')


if __name__ == '__main__':
    unittest.main(verbosity=1)
