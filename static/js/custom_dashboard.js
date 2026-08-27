/**
 * 自定义看板：查看端渲染 + 向导式配置器。
 *
 * 设计要点：
 * 1. 图表全部手绘 inline SVG，与 home_dashboard.js 保持一致，不引入图表库。
 * 2. 配置器不让用户写 SQL，只能挑「已保存的自定义SQL脚本」；选完脚本后调 /preview
 *    拿真实列名填进下拉框，非开发人员照着提示点就能配出来。
 * 3. 每个区块独立执行、独立报错，一块失败不影响其他块。
 */
(function () {
    'use strict';

    const GRID_COLUMNS = 12;
    const MAX_BLOCKS = 30;
    // 饼图/图例配色：与主题色系无关的固定色板，保证多分类可区分。
    const PALETTE = ['#5b6cff', '#0f9f75', '#dd7a1d', '#7c5ce5', '#148aa3', '#d55261', '#c2a012', '#4f8ef7', '#2f9e6f', '#b4632f'];

    const BLOCK_TYPES = [
        { value: 'metric', label: '核心指标', icon: 'fa-bolt', hint: '突出显示一个关键数字，可配置环比列。' },
        { value: 'metric_group', label: '指标组', icon: 'fa-th', hint: '一块展示多个核心指标，适合总览首行。' },
        { value: 'gauge', label: '仪表盘', icon: 'fa-tachometer', hint: '展示当前值、上下限与目标值。' },
        { value: 'ranking', label: '排名榜', icon: 'fa-list-ol', hint: '按数值展示带进度条的 Top 排名。' },
        { value: 'status', label: '状态牌', icon: 'fa-circle', hint: '突出展示正常、告警、异常等当前状态。' },
        { value: 'comparison', label: '对比指标', icon: 'fa-exchange', hint: '并列展示当前值、对比值和变化幅度。' },
        { value: 'table', label: '明细表格', icon: 'fa-table', hint: '按行列展示明细数据，适合核对具体记录。' },
        { value: 'line', label: '多系列折线', icon: 'fa-line-chart', hint: '一张图展示多条趋势线。' },
        { value: 'area', label: '面积趋势', icon: 'fa-area-chart', hint: '用面积强调趋势规模，可展示多系列。' },
        { value: 'grouped_bar', label: '分组柱图', icon: 'fa-bar-chart', hint: '同一分类并排比较多个指标。' },
        { value: 'stacked_bar', label: '堆叠柱图', icon: 'fa-bar-chart', hint: '观察总量以及各组成部分。' },
        { value: 'bar', label: '柱状图', icon: 'fa-bar-chart', hint: '兼容旧看板的单系列柱状图。' },
        { value: 'pie', label: '占比图', icon: 'fa-pie-chart', hint: '支持标准、环形、玫瑰与半环四种样式。' },
        { value: 'progress', label: '进度条', icon: 'fa-tasks', hint: '按目标值展示完成率、达成率。' },
        { value: 'alert_list', label: '告警列表', icon: 'fa-warning', hint: '动态展示告警级别、标题与详情。' },
        { value: 'timeline', label: '事件时间线', icon: 'fa-clock-o', hint: '按时间顺序展示动态事件。' },
        { value: 'clock', label: '时钟', icon: 'fa-clock-o', hint: '无需脚本，显示当前日期时间。' },
        { value: 'section', label: '分区标题', icon: 'fa-header', hint: '无需脚本，为大屏内容分区。' },
        { value: 'text', label: '说明文字', icon: 'fa-font', hint: '无需脚本，展示口径与说明。' }
    ];

    const WIDTH_PRESETS = Array.from({ length: 12 }, (_, index) => ({
        value: index + 1,
        label: `${index + 1} 格（${index + 1}/12）${index === 11 ? ' · 整行' : ''}`
    }));

    const PIE_STYLES = [
        { value: 'standard', label: '标准饼图' }, { value: 'donut', label: '环形图' },
        { value: 'rose', label: '南丁格尔玫瑰图' }, { value: 'half', label: '半环图' }
    ];
    const PREVIEW_SIZES = {
        auto: { label: '自适应', width: 0, height: 0 },
        hd: { label: '1920 × 1080', width: 1920, height: 1080 },
        laptop: { label: '1366 × 768', width: 1366, height: 768 }
    };

    const AGGREGATES = [
        { value: 'first', label: '取第一行的值' },
        { value: 'sum', label: '所有行求和' },
        { value: 'avg', label: '所有行求平均' },
        { value: 'max', label: '取最大值' },
        { value: 'min', label: '取最小值' },
        { value: 'count', label: '统计行数（不用选数值列）' }
    ];

    // 看板背景主题，和后端 ALLOWED_THEMES 一一对应，顺序即选择器里的顺序。
    // 背景主题。分三组是为了让挑选的人一眼知道深浅——白天挂的看板选浅色组不刺眼。
    // 这里的 value 必须和后端 ALLOWED_THEMES 完全一致，否则保存时会被打回默认值。
    const THEMES = [
        { value: 'command_center', label: '指挥中心', group: '高级大屏', featured: true },
        { value: 'quantum', label: '量子蓝', group: '高级大屏', featured: true },
        { value: 'matrix', label: '矩阵绿', group: '高级大屏', featured: true },
        { value: 'obsidian_gold', label: '曜石金', group: '高级大屏', featured: true },
        { value: 'polar_night', label: '极地夜', group: '高级大屏', featured: true },
        { value: 'crimson_ops', label: '赤焰战情', group: '高级大屏', featured: true },
        { value: 'cyber_cyan', label: '赛博青', group: '高级大屏', featured: true },
        { value: 'deep_space', label: '深空星云', group: '高级大屏', featured: true },
        { value: 'industrial_amber', label: '工业琥珀', group: '高级大屏', featured: true },
        { value: 'emerald_ops', label: '运维翡翠', group: '高级大屏', featured: true },
        { value: 'black_gold', label: '黑金经营', group: '高级大屏', featured: true },
        { value: 'data_white', label: '数据白', group: '高级大屏', featured: true },
        { value: 'aurora', label: '极光紫', group: '深色' },
        { value: 'midnight', label: '午夜蓝', group: '深色' },
        { value: 'ocean', label: '深海青', group: '深色' },
        { value: 'ember', label: '暮光橙', group: '深色' },
        { value: 'forest', label: '松林绿', group: '深色' },
        { value: 'plum', label: '莓果紫', group: '深色' },
        { value: 'slate', label: '石墨灰', group: '深色' },
        { value: 'indigo', label: '靛青', group: '深色' },
        { value: 'teal', label: '孔雀蓝', group: '深色' },
        { value: 'navy', label: '藏青', group: '深色' },
        { value: 'olive', label: '橄榄', group: '深色' },
        { value: 'maroon', label: '栗红', group: '深色' },
        { value: 'cocoa', label: '可可', group: '深色' },
        { value: 'denim', label: '牛仔蓝', group: '深色' },
        { value: 'jade', label: '翡翠', group: '深色' },
        { value: 'rust', label: '铁锈', group: '深色' },
        { value: 'iron', label: '生铁', group: '深色' },
        { value: 'violet', label: '紫罗兰', group: '深色' },
        { value: 'pine', label: '雪松', group: '深色' },
        { value: 'onyx', label: '曜石', group: '深色' },
        { value: 'cobalt', label: '钴蓝', group: '深色' },
        { value: 'amethyst', label: '紫水晶', group: '深色' },
        { value: 'brick', label: '砖红', group: '深色' },
        { value: 'lagoon', label: '礁湖', group: '深色' },
        { value: 'moor', label: '荒原', group: '深色' },
        { value: 'bronze', label: '古铜', group: '深色' },
        { value: 'nebula', label: '星云', group: '渐变' },
        { value: 'abyss', label: '深渊', group: '渐变' },
        { value: 'aurora_borealis', label: '北极光', group: '渐变' },
        { value: 'sunset', label: '晚霞', group: '渐变' },
        { value: 'cyber', label: '赛博', group: '渐变' },
        { value: 'moss', label: '苔原', group: '渐变' },
        { value: 'graphite', label: '玄铁', group: '渐变' },
        { value: 'wine', label: '酒红', group: '渐变' },
        { value: 'tropic', label: '热带', group: '渐变' },
        { value: 'magma', label: '岩浆', group: '渐变' },
        { value: 'galaxy', label: '银河', group: '渐变' },
        { value: 'peacock', label: '孔雀', group: '渐变' },
        { value: 'dusk', label: '黄昏', group: '渐变' },
        { value: 'reef', label: '珊瑚礁', group: '渐变' },
        { value: 'orchid', label: '兰紫', group: '渐变' },
        { value: 'copper', label: '铜绿', group: '渐变' },
        { value: 'glacier', label: '冰川', group: '渐变' },
        { value: 'twilight', label: '暮色', group: '渐变' },
        { value: 'lava', label: '熔岩', group: '渐变' },
        { value: 'jungle', label: '雨林', group: '渐变' },
        { value: 'neonight', label: '霓虹夜', group: '渐变' },
        { value: 'harbor', label: '港湾', group: '渐变' },
        { value: 'blaze', label: '烈焰', group: '渐变' },
        { value: 'iris', label: '鸢尾', group: '渐变' },
        { value: 'canyon', label: '峡谷', group: '渐变' },
        { value: 'spruce', label: '云杉', group: '渐变' },
        { value: 'nightfall', label: '入夜', group: '渐变' },
        { value: 'punch', label: '果酒', group: '渐变' },
        { value: 'tide', label: '潮汐', group: '渐变' },
        { value: 'nebula2', label: '星云 II', group: '渐变' },
        { value: 'verdant', label: '青翠', group: '渐变' },
        { value: 'daylight', label: '晴日', group: '浅色' },
        { value: 'linen', label: '亚麻', group: '浅色' },
        { value: 'mint', label: '薄荷', group: '浅色' },
        { value: 'sakura', label: '樱粉', group: '浅色' },
        { value: 'sand', label: '暖沙', group: '浅色' },
        { value: 'seafoam', label: '海沫', group: '浅色' },
        { value: 'pearl', label: '珍珠', group: '浅色' },
        { value: 'blossom', label: '丁香', group: '浅色' },
        { value: 'celadon', label: '青瓷', group: '浅色' },
        { value: 'ivory', label: '象牙', group: '浅色' },
        { value: 'porcelain', label: '白瓷', group: '浅色' },
        { value: 'peach', label: '蜜桃', group: '浅色' },
        { value: 'lilac', label: '浅紫', group: '浅色' },
        { value: 'sky', label: '天青', group: '浅色' },
        { value: 'oat', label: '燕麦', group: '浅色' },
        { value: 'lemonade', label: '柠檬水', group: '浅色' },
        { value: 'rosewater', label: '玫瑰水', group: '浅色' },
        { value: 'aqua', label: '水蓝', group: '浅色' },
        { value: 'cloud', label: '云白', group: '浅色' },
        { value: 'honey', label: '蜂蜜', group: '浅色' },
        { value: 'fresco', label: '壁彩', group: '浅色' },
        { value: 'basil', label: '罗勒', group: '浅色' },
        { value: 'parchment', label: '羊皮纸', group: '浅色' },
        { value: 'glaze', label: '釉白', group: '浅色' },
        { value: 'coral', label: '珊瑚', group: '浅色' },
        { value: 'frost', label: '霜蓝', group: '浅色' }
    ];
    const THEME_GROUPS = ['高级大屏', '深色', '渐变', '浅色'];
    // 浅色主题：舞台上的文字要用深色，模板和预览都靠这个列表判断。
    const LIGHT_THEMES = ['data_white', 'daylight', 'linen', 'mint', 'sakura', 'sand', 'seafoam', 'pearl', 'blossom',
        'celadon', 'ivory', 'porcelain', 'peach', 'lilac', 'sky', 'oat', 'lemonade', 'rosewater',
        'aqua', 'cloud', 'honey', 'fresco', 'basil', 'parchment', 'glaze', 'coral', 'frost'];

    // 下面几组是后端白名单的前端镜像。少一项界面就会给出后端不认的值，
    // 保存后静默回落成默认值，看起来像"设置没生效"。
    const BLOCK_BACKGROUNDS = ['theme', 'glass', 'solid', 'frost', 'outline', 'shadow', 'custom'];
    // 没有表头底色的档位：那条横带跟着这一块的底色走，只让人配字号和文字颜色。
    const ALIGNS = ['left', 'center', 'right'];
    const TITLE_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'];
    const VALUE_SIZES = ['sm', 'md', 'lg', 'xl', 'xxl', 'huge'];
    const TABLE_SIZES = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'];
    const TABLE_MODES = ['paged', 'scroll', 'lazy', 'marquee'];
    const BG_FITS = ['cover', 'contain', 'tile'];
    // 看板名称（舞台大标题）的字号档，和后端 ALLOWED_NAME_SIZES 一一对应。
    const NAME_SIZES = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'];

    /** 取白名单里的值，不在名单里就回落默认。拼 class 名之前必须过这一道。 */
    function allow(value, list, fallback) {
        return list.indexOf(value) >= 0 ? value : fallback;
    }

    function clampInt(value, fallback, min, max) {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.max(min, Math.min(max, Math.round(num)));
    }

    // 界面上的选项文案。用"人话"写，配置的人不一定懂 CSS。
    const BG_PRESET_OPTIONS = [
        { value: 'theme', label: '跟随主题（默认白底卡片）' },
        { value: 'glass', label: '毛玻璃（透出背景，深色主题上好看）' },
        { value: 'solid', label: '纯白卡片' },
        { value: 'frost', label: '磨砂白（半透，浅色主题上好看）' },
        { value: 'outline', label: '只留描边（完全透明）' },
        { value: 'shadow', label: '深色玻璃（背景图上文字最清楚）' },
        { value: 'custom', label: '自定义颜色…' }
    ];
    const ALIGN_OPTIONS = [
        { value: 'left', label: '靠左' },
        { value: 'center', label: '居中' },
        { value: 'right', label: '靠右' }
    ];
    const TITLE_SIZE_OPTIONS = [
        { value: 'xs', label: '很小' }, { value: 'sm', label: '小（默认）' },
        { value: 'md', label: '中' }, { value: 'lg', label: '大' }, { value: 'xl', label: '很大' }
    ];
    const VALUE_SIZE_OPTIONS = [
        { value: 'sm', label: '小' }, { value: 'md', label: '中' }, { value: 'lg', label: '大' },
        { value: 'xl', label: '很大（默认）' }, { value: 'xxl', label: '超大' }, { value: 'huge', label: '巨大（挂大屏用）' }
    ];
    // 档位加到 xxl(26px)：挂大屏时 lg(19px) 还是偏小。
    // 标注「默认」的必须是 md——之前标在 sm 上是错的（实际默认早就是 md），
    // 用户照着标注去选反而把字改小了。
    const TABLE_SIZE_OPTIONS = [
        { value: 'xs', label: '很小' }, { value: 'sm', label: '小' },
        { value: 'md', label: '中（默认）' }, { value: 'lg', label: '大' },
        { value: 'xl', label: '很大' }, { value: 'xxl', label: '超大（挂大屏用）' }
    ];
    // 看板名称的字号：比区块标题那套整体大一截，它是几米外要看清的那行字。
    const NAME_SIZE_OPTIONS = [
        { value: 'xs', label: '很小 18px' }, { value: 'sm', label: '小 22px' },
        { value: 'md', label: '中 27px（默认）' }, { value: 'lg', label: '大 34px' },
        { value: 'xl', label: '很大 42px' }, { value: 'xxl', label: '超大 54px（挂大屏用）' }
    ];
    const TABLE_MODE_OPTIONS = [
        { value: 'paged', label: '只显示前几行（默认）' },
        { value: 'scroll', label: '区块内可滚动（滚动条已隐藏）' },
        { value: 'lazy', label: '滚到底自动加载下一批' },
        { value: 'marquee', label: '自动匀速滚动（挂大屏免操作）' }
    ];
    const MODE_HINTS = {
        paged: '超出的行不显示，只在底部标一句"共多少行"。',
        scroll: '在这一块里上下滚就能看完，滚动条已经隐藏，不影响美观。',
        lazy: '先显示一批，往下滚自动接上下一批，不会出现很长的滚动条。',
        marquee: '自己匀速往上滚，循环播放。挂大屏没人操作时用这个。'
    };
    const BG_FIT_OPTIONS = [
        { value: 'cover', label: '铺满整屏（会裁掉边缘）' },
        { value: 'contain', label: '完整显示（可能留边）' },
        { value: 'tile', label: '平铺（适合小图做底纹）' }
    ];

    /* 常用配色，给非开发人员点选用；仍可在后面的输入框里填任意十六进制色值。
       按 12 一行摆三行：中性灰阶 / 明亮色 / 深色。
       为什么要深色那一行：表头底色、自定义块底色这些"底"用的色，浅色根本压不住文字，
       只给明亮色等于让人必须自己查十六进制。行数和 .dash-swatch-row 的 12 列对齐，
       改成非 12 的倍数会在最后一行留半排空格。 */
    const COLOR_SWATCHES = [
        '#ffffff', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b',
        '#475569', '#334155', '#1e293b', '#0f172a', '#111827', '#000000',
        '#38bdf8', '#22d3ee', '#2dd4bf', '#34d399', '#a3e635', '#facc15',
        '#fbbf24', '#fb923c', '#f87171', '#f472b6', '#c084fc', '#818cf8',
        '#0284c7', '#0e7490', '#0f766e', '#047857', '#4d7c0f', '#a16207',
        '#b45309', '#c2410c', '#b91c1c', '#be185d', '#7e22ce', '#4338ca'
    ];

    // 三个可自定义的配色位：字段名 -> 界面上的说明。
    const COLOR_FIELDS = [
        { key: 'title_color', label: '标题文字', hint: '这一块左上角的标题颜色。' },
        { key: 'value_color', label: '数字 / 正文', hint: '数字块的大号数字、文字块的正文颜色。' },
        { key: 'accent_color', label: '图表 / 进度条', hint: '柱状图、进度条、趋势标记的主色。' },
        { key: 'header_color', label: '表头文字', hint: '最上面那行列名的文字颜色。' },
        // 没有"表头底色"这一项：那条横带的底色跟着这一块的底色走，不单独配。
        // 之前给它单独一套档位/取色器，配出来的深浅总要跟块底色再对一遍，不如直接跟随。
        { key: 'cell_color', label: '表格数据', hint: '列表里每一行数据文字的颜色。' }
    ];

    let scriptCatalog = [];
    let dashboardSummaries = [];
    // 已上传的背景图（只有元数据，图片本体走 /assets/<id>/raw 取）
    let assetCatalog = [];
    let canManage = false;
    let editorState = null;
    let initialized = false;
    // 缓存键 -> {columns, rows, total, error}；避免同一脚本反复预览。
    const previewCache = new Map();
    // block id -> 请求序号。切换脚本/变量后旧请求即使晚返回，也不能覆盖新脚本的预览。
    const previewRequests = new Map();

    /** 缓存键要带上变量值：同一脚本换了变量就是另一条 SQL，不能复用上一次的结果。 */
    function previewKey(block) {
        const params = block.params || {};
        const names = Object.keys(params).sort();
        if (!names.length) return block.script_id || '';
        return `${block.script_id}|${names.map(name => `${name}=${params[name]}`).join('&')}`;
    }

    function el(id) { return document.getElementById(id); }

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
    }

    function toNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        const text = String(value).trim().replace(/,/g, '').replace(/%$/, '');
        if (!text) return null;
        const parsed = Number(text);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function formatNumber(value, decimals) {
        const num = toNumber(value);
        if (num === null) return value === null || value === undefined ? '-' : String(value);
        const digits = typeof decimals === 'number' ? decimals : (Number.isInteger(num) ? 0 : 2);
        return num.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    /** 颜色白名单：只放行 #rgb / #rrggbb。颜色会进内联 style，必须严格校验。 */
    function safeColor(value) {
        const text = String(value || '').trim();
        return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text) ? text : '';
    }

    function shortenLabel(value, limit) {
        const text = String(value === null || value === undefined ? '' : value);
        const max = limit || 10;
        return text.length > max ? text.slice(0, max - 1) + '…' : text;
    }

    function columnIndex(columns, name) {
        const index = (columns || []).indexOf(name);
        return index >= 0 ? index : -1;
    }

    function cellValue(row, columns, name) {
        if (!row) return null;
        if (!Array.isArray(row)) return row[name];
        const index = columnIndex(columns, name);
        return index >= 0 ? row[index] : null;
    }

    /** 猜第一个数值列 / 第一个非数值列，用于给配置器填默认值。 */
    function guessColumns(columns, rows) {
        const sample = (rows || [])[0];
        const numeric = [];
        const textual = [];
        (columns || []).forEach(name => {
            const value = sample ? cellValue(sample, columns, name) : null;
            if (toNumber(value) !== null) numeric.push(name); else textual.push(name);
        });
        return { numeric, textual };
    }

    // ---------- 图表渲染（手绘 SVG） ----------

    /** 从区块结果里抽出 [{label, value}]；v2 统一从 value_columns 取，兼容旧 value_column。 */
    function seriesFrom(block, result) {
        const columns = result.columns || [];
        const rows = result.rows || [];
        const labelKey = block.label_column || columns[0];
        const valueKeys = Array.isArray(block.value_columns) && block.value_columns.length
            ? block.value_columns : [block.value_column || columns[1] || columns[0]];
        const valueKey = valueKeys[0];
        return rows.map((row, index) => {
            const rawLabel = block.label_column ? cellValue(row, columns, labelKey) : (columns.length > 1 ? cellValue(row, columns, labelKey) : index + 1);
            const value = toNumber(cellValue(row, columns, valueKey));
            return { label: rawLabel === null || rawLabel === undefined || rawLabel === '' ? `第 ${index + 1} 行` : String(rawLabel), value: value === null ? 0 : value };
        });
    }

    /** 多系列图表的统一数据结构，最多 8 条，字段名同时作为图例名称。 */
    function multiSeriesFrom(block, result) {
        const columns = result.columns || [];
        const rows = (result.rows || []).slice(0, block.max_items || 60);
        const labelKey = block.label_column || columns[0];
        let keys = Array.isArray(block.value_columns) ? block.value_columns.filter(key => columns.includes(key)) : [];
        if (!keys.length && block.value_column) keys = [block.value_column];
        if (!keys.length) keys = columns.filter(key => key !== labelKey).slice(0, 1);
        return {
            labels: rows.map((row, index) => String(cellValue(row, columns, labelKey) ?? `第 ${index + 1} 行`)),
            series: keys.slice(0, 8).map((key, seriesIndex) => ({
                name: key, color: PALETTE[seriesIndex % PALETTE.length],
                values: rows.map(row => toNumber(cellValue(row, columns, key)) || 0)
            }))
        };
    }

    function renderBar(series) {
        if (!series.length) return emptyBody('这个脚本没有返回可用于绘图的数据');
        const data = series.slice(0, 14);
        const width = 480;
        const height = 210;
        const padLeft = 40;
        const padRight = 12;
        const padTop = 14;
        const padBottom = 42;
        const plotWidth = width - padLeft - padRight;
        const plotHeight = height - padTop - padBottom;
        const maxValue = Math.max(...data.map(item => item.value), 0) || 1;
        const step = plotWidth / data.length;
        const barWidth = Math.max(8, Math.min(38, step * 0.58));

        let svg = `<svg class="dash-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">`;
        for (let i = 0; i <= 4; i += 1) {
            const y = padTop + (plotHeight / 4) * i;
            const tick = maxValue - (maxValue / 4) * i;
            svg += `<line class="dash-chart-grid" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}"></line>`;
            svg += `<text class="dash-chart-label" x="${padLeft - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${escapeHtml(formatNumber(tick, tick >= 100 ? 0 : 1))}</text>`;
        }
        data.forEach((item, index) => {
            const barHeight = Math.max(1, (item.value / maxValue) * plotHeight);
            const x = padLeft + step * index + (step - barWidth) / 2;
            const y = padTop + plotHeight - barHeight;
            svg += `<rect class="dash-chart-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}"><title>${escapeHtml(item.label)}: ${escapeHtml(formatNumber(item.value))}</title></rect>`;
            svg += `<text class="dash-chart-value" x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${escapeHtml(formatNumber(item.value))}</text>`;
            svg += `<text class="dash-chart-label" x="${(x + barWidth / 2).toFixed(1)}" y="${height - padBottom + 15}" text-anchor="middle" transform="rotate(-22 ${(x + barWidth / 2).toFixed(1)} ${height - padBottom + 15})">${escapeHtml(shortenLabel(item.label, 9))}</text>`;
        });
        svg += '</svg>';
        return svg;
    }

    /**
     * 把坐标轴上限收成"整数感"的刻度：3519 -> 4000，87 -> 100，0.42 -> 0.5。
     * 为何要这一步：直接拿最大值当顶，刻度就变成 3,519 / 2,639 / 1,760 这种怪数字
     * （用户说的"不好看"主要是这个）。取整后每一格都是 1000 这样的整数。
     * 做法是取跟数量级匹配的 1 / 2 / 2.5 / 5 / 10 倍数里第一个装得下的。
     */
    function niceCeil(value, segments) {
        if (!(value > 0)) return 1;
        const rough = value / (segments || 4);
        const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
        const normalized = rough / magnitude;
        // 梯子给密一点：只有 1/2/2.5/5/10 的话 12500 会被抬到 20000，
        // 顶上白留四成高度，图反而更难看。补上 1.5/3/4/6/8 后贴得更紧。
        // 梯子里的每一档就是"每格的增量"（顶端 = 增量 × 4），所以挑的都是看着顺眼的数：
        // 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 7.5 / 10。
        const stepUnit = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10].find(unit => normalized <= unit) || 10;
        // 乘回去会带出 0.6000000000000001 这类浮点尾巴，按量级四舍五入掉。
        const top = stepUnit * magnitude * (segments || 4);
        const precision = Math.pow(10, Math.max(0, -Math.floor(Math.log10(magnitude)) + 2));
        return Math.round(top * precision) / precision;
    }

    /**
     * X 轴上的日期只留月-日：整块宽度就那么点，10 个字符的完整日期横排必然互相压，
     * 斜排虽然不压了但很占地方也不好看。同一张图里年份基本相同，砍掉不丢信息。
     * 非日期的标签原样返回，只做长度截断。
     */
    function axisLabel(value) {
        const text = String(value === null || value === undefined ? '' : value);
        const date = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (date) return `${date[2]}-${date[3]}`;
        const stamp = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
        if (stamp) return `${stamp[2]}-${stamp[3]} ${stamp[4]}:${stamp[5]}`;
        return shortenLabel(text, 10);
    }

    function renderLine(series) {
        if (!series.length) return emptyBody('这个脚本没有返回可用于绘图的数据');
        const data = series.slice(0, 60);
        const width = 480;
        const height = 210;
        const padLeft = 44;
        // 右边留宽一点：最后一个 X 轴刻度就落在这条边上，太窄的话标签会被裁掉半截。
        const padRight = 20;
        const padTop = 16;
        // 标签横排（月-日 只有 5 个字符，不用再斜排），底部留一行的高度就够。
        const padBottom = 30;
        const plotWidth = width - padLeft - padRight;
        const plotHeight = height - padTop - padBottom;
        const values = data.map(item => item.value);
        const rawMax = Math.max(...values);
        const rawMin = Math.min(...values);
        // 全负数的情况下把上限压到 0，否则顶端刻度取整数感的上界。
        const maxValue = rawMax > 0 ? niceCeil(rawMax, 4) : 0;
        const minValue = rawMin < 0 ? -niceCeil(-rawMin, 4) : 0;
        const span = (maxValue - minValue) || 1;
        const step = data.length > 1 ? plotWidth / (data.length - 1) : 0;
        const pointAt = index => {
            const x = padLeft + step * index + (data.length > 1 ? 0 : plotWidth / 2);
            const y = padTop + plotHeight - ((data[index].value - minValue) / span) * plotHeight;
            return { x, y };
        };

        let svg = `<svg class="dash-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">`;
        // 刻度整数感之后每格都是整数，直接按 0 位小数显示；只有跨度不到 4 才保留 1 位。
        const tickDigits = span >= 4 ? 0 : 1;
        for (let i = 0; i <= 4; i += 1) {
            const y = padTop + (plotHeight / 4) * i;
            const tick = maxValue - (span / 4) * i;
            svg += `<line class="dash-chart-grid" x1="${padLeft}" y1="${y.toFixed(1)}" x2="${width - padRight}" y2="${y.toFixed(1)}"></line>`;
            svg += `<text class="dash-chart-label" x="${padLeft - 7}" y="${(y + 3).toFixed(1)}" text-anchor="end">${escapeHtml(formatNumber(tick, tickDigits))}</text>`;
        }
        const points = data.map((item, index) => pointAt(index));
        const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
        const area = `${path} L${points[points.length - 1].x.toFixed(1)},${padTop + plotHeight} L${points[0].x.toFixed(1)},${padTop + plotHeight} Z`;
        svg += `<path class="dash-chart-area" d="${area}"></path><path class="dash-chart-line" d="${path}"></path>`;
        // X 轴标签横排，间隔按可用宽度算：axisLabel 把日期砍成"月-日"只剩 5 个字符,
        // 9px 字大约占 30px，留 42px 的间距就不会互相压，也就不用再斜排。
        // 斜排虽然能塞下完整日期，但占掉三分之一块高，反而更难看。
        const maxLabels = Math.max(2, Math.floor(plotWidth / 42));
        const labelEvery = Math.max(1, Math.ceil(data.length / maxLabels));
        const labelY = height - padBottom + 17;
        const drawLabel = index => {
            const point = points[index];
            // 首尾两个标签改锚点：首个左对齐、末个右对齐，居中锚点会让它们各有一半
            // 伸到 viewBox 外面被裁掉（就是之前"X 轴没显示完整"的原因）。
            const anchor = index === 0 ? 'start' : (index === data.length - 1 ? 'end' : 'middle');
            return `<text class="dash-chart-label" x="${point.x.toFixed(1)}" y="${labelY}" text-anchor="${anchor}">${escapeHtml(axisLabel(data[index].label))}</text>`;
        };
        points.forEach((point, index) => {
            if (data.length <= 30) {
                svg += `<circle class="dash-chart-dot" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3"><title>${escapeHtml(data[index].label)}: ${escapeHtml(formatNumber(data[index].value))}</title></circle>`;
            }
            // 末尾那个总要画（不然轴线右端没有刻度），但它跟前一个按间隔画出来的
            // 离得太近就会叠字，那种情况下让位给末尾这个。
            const isLast = index === data.length - 1;
            const onGrid = index % labelEvery === 0;
            const crowdedByLast = onGrid && !isLast && data.length - 1 - index < labelEvery;
            if ((onGrid && !crowdedByLast) || isLast) svg += drawLabel(index);
        });
        svg += '</svg>';
        return svg;
    }

    function renderMultiLine(block, result) {
        const data = multiSeriesFrom(block, result);
        if (!data.labels.length || !data.series.length) return emptyBody('没有可用于绘图的数据');
        const width = 520, height = 230, left = 46, right = 18, top = 18, bottom = 36;
        const plotW = width - left - right, plotH = height - top - bottom;
        const all = data.series.flatMap(item => item.values);
        const max = niceCeil(Math.max(...all, 0), 4), min = Math.min(...all, 0), span = max - min || 1;
        const x = i => left + (data.labels.length > 1 ? i * plotW / (data.labels.length - 1) : plotW / 2);
        const y = value => top + plotH - (value - min) / span * plotH;
        let svg = `<svg class="dash-chart" viewBox="0 0 ${width} ${height}" role="img">`;
        for (let i = 0; i <= 4; i++) {
            const gy = top + i * plotH / 4, tick = max - i * span / 4;
            svg += `<line class="dash-chart-grid" x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}"></line>`;
            svg += `<text class="dash-chart-label" x="${left-6}" y="${gy+3}" text-anchor="end">${escapeHtml(formatNumber(tick, span < 4 ? 1 : 0))}</text>`;
        }
        data.series.forEach(item => {
            const path = item.values.map((value, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
            if (block.type === 'area') svg += `<path class="dash-chart-series-area" style="fill:${item.color}" d="${path} L${x(item.values.length-1)},${top+plotH} L${x(0)},${top+plotH} Z"></path>`;
            svg += `<path class="dash-chart-series" style="stroke:${item.color}" d="${path}"></path>`;
        });
        const every = Math.max(1, Math.ceil(data.labels.length / 8));
        data.labels.forEach((label, i) => { if (i % every === 0 || i === data.labels.length - 1) svg += `<text class="dash-chart-label" x="${x(i)}" y="${height-10}" text-anchor="middle">${escapeHtml(axisLabel(label))}</text>`; });
        svg += '</svg>';
        return svg + renderSeriesLegend(data.series);
    }

    function renderSeriesLegend(series) {
        return `<div class="dash-legend">${series.map(item => `<span class="dash-legend-item"><i class="dash-legend-dot" style="background:${item.color}"></i>${escapeHtml(item.name)}</span>`).join('')}</div>`;
    }

    function renderPie(series, block) {
        const data = series.slice(0, 10).filter(item => item.value > 0);
        if (!data.length) return emptyBody('数值全部为 0，占比图画不出来');
        const total = data.reduce((sum, item) => sum + item.value, 0);
        const style = allow(block && block.pie_style, ['standard', 'donut', 'rose', 'half'], 'donut');
        const size = 210, center = size / 2, maxRadius = style === 'half' ? 82 : 76;
        const startAngle = style === 'half' ? Math.PI : -Math.PI / 2;
        const fullAngle = style === 'half' ? Math.PI : Math.PI * 2;
        let angle = startAngle;
        let svg = `<svg class="dash-chart dash-pie-${style}" viewBox="0 0 ${size} ${style === 'half' ? 126 : size}" style="max-width:230px;margin:0 auto" role="img">`;
        data.forEach((item, index) => {
            const sweep = item.value / total * fullAngle;
            const end = angle + sweep;
            const radius = style === 'rose' ? maxRadius * (.42 + .58 * Math.sqrt(item.value / Math.max(...data.map(d => d.value)))) : maxRadius;
            const x1 = center + radius * Math.cos(angle), y1 = center + radius * Math.sin(angle);
            const x2 = center + radius * Math.cos(end), y2 = center + radius * Math.sin(end);
            const largeArc = sweep > Math.PI ? 1 : 0;
            svg += `<path class="dash-chart-slice" fill="${PALETTE[index % PALETTE.length]}" d="M${center},${center} L${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z"><title>${escapeHtml(item.label)}: ${escapeHtml(formatNumber(item.value))}</title></path>`;
            if (block && block.show_labels !== false) {
                const middle = angle + sweep / 2, lr = radius * .68;
                svg += `<text class="dash-pie-label" x="${center + lr * Math.cos(middle)}" y="${center + lr * Math.sin(middle)}" text-anchor="middle">${(item.value / total * 100).toFixed(0)}%</text>`;
            }
            angle = end;
        });
        if (style === 'donut' || style === 'half') {
            const inner = style === 'half' ? 49 : 42;
            svg += `<circle cx="${center}" cy="${center}" r="${inner}" fill="var(--surface)"></circle>`;
            svg += `<text x="${center}" y="${style === 'half' ? center - 4 : center + 4}" text-anchor="middle" class="dash-pie-total">${escapeHtml(formatNumber(total))}</text>`;
        }
        svg += '</svg>';
        if (!block || block.show_legend !== false) svg += renderSeriesLegend(data.map((item, index) => ({ name: `${item.label} ${(item.value / total * 100).toFixed(1)}%`, color: PALETTE[index % PALETTE.length] })));
        return svg;
    }

    function renderMultiBar(block, result) {
        const data = multiSeriesFrom(block, result);
        if (!data.labels.length || !data.series.length) return emptyBody('没有可用于绘图的数据');
        const width = 520, height = 230, left = 42, right = 12, top = 16, bottom = 38;
        const plotW = width - left - right, plotH = height - top - bottom;
        const stacked = block.type === 'stacked_bar';
        const totals = data.labels.map((_, i) => stacked ? data.series.reduce((sum, s) => sum + Math.max(0, s.values[i]), 0) : Math.max(...data.series.map(s => s.values[i]), 0));
        const max = niceCeil(Math.max(...totals, 1), 4), groupW = plotW / data.labels.length;
        let svg = `<svg class="dash-chart" viewBox="0 0 ${width} ${height}" role="img">`;
        for (let i = 0; i <= 4; i++) {
            const gy = top + i * plotH / 4;
            svg += `<line class="dash-chart-grid" x1="${left}" y1="${gy}" x2="${width-right}" y2="${gy}"></line>`;
        }
        data.labels.forEach((label, i) => {
            let stackY = top + plotH;
            data.series.forEach((series, si) => {
                const value = Math.max(0, series.values[i]), barH = value / max * plotH;
                const barW = stacked ? groupW * .62 : groupW * .72 / data.series.length;
                const x = stacked ? left + i * groupW + groupW * .19 : left + i * groupW + groupW * .14 + si * barW;
                const y = stacked ? stackY - barH : top + plotH - barH;
                svg += `<rect class="dash-chart-multi-bar" fill="${series.color}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2, barW-2).toFixed(1)}" height="${Math.max(1, barH).toFixed(1)}"><title>${escapeHtml(label)} · ${escapeHtml(series.name)}: ${escapeHtml(formatNumber(value))}</title></rect>`;
                if (stacked) stackY = y;
            });
            svg += `<text class="dash-chart-label" x="${left + (i+.5)*groupW}" y="${height-11}" text-anchor="middle">${escapeHtml(axisLabel(label))}</text>`;
        });
        svg += '</svg>';
        return svg + renderSeriesLegend(data.series);
    }

    function renderGauge(block, result) {
        const value = metricValue(block, result);
        const min = toNumber(block.min_value) ?? 0, max = toNumber(block.max_value) ?? 100;
        const ratio = Math.max(0, Math.min(1, ((toNumber(value) ?? min) - min) / ((max - min) || 1)));
        const angle = -135 + ratio * 270, rad = angle * Math.PI / 180;
        const x = 100 + Math.cos(rad) * 58, y = 96 + Math.sin(rad) * 58;
        const target = toNumber(block.target_value);
        let targetMark = '';
        if (target !== null && target >= min && target <= max) {
            const targetRatio = (target - min) / ((max - min) || 1);
            const targetRad = (-135 + targetRatio * 270) * Math.PI / 180;
            const tx1 = 100 + Math.cos(targetRad) * 65, ty1 = 96 + Math.sin(targetRad) * 65;
            const tx2 = 100 + Math.cos(targetRad) * 78, ty2 = 96 + Math.sin(targetRad) * 78;
            targetMark = `<line class="dash-gauge-target" x1="${tx1.toFixed(1)}" y1="${ty1.toFixed(1)}" x2="${tx2.toFixed(1)}" y2="${ty2.toFixed(1)}"><title>目标值 ${escapeHtml(formatNumber(target, block.decimals))}</title></line>`;
        }
        return `<div class="dash-gauge"><svg viewBox="0 0 200 145" role="img">
            <path class="dash-gauge-track" d="M50 130 A72 72 0 1 1 150 130"></path>
            <path class="dash-gauge-value" pathLength="100" stroke-dasharray="${(ratio*100).toFixed(1)} 100" d="M50 130 A72 72 0 1 1 150 130"></path>
            ${targetMark}<line class="dash-gauge-needle" x1="100" y1="96" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"></line><circle cx="100" cy="96" r="5" class="dash-gauge-hub"></circle>
            <text x="100" y="121" text-anchor="middle" class="dash-gauge-number">${escapeHtml(formatNumber(value, block.decimals))}${escapeHtml(block.unit || '')}</text>
            <text x="36" y="142" class="dash-chart-label">${escapeHtml(min)}</text><text x="164" y="142" text-anchor="end" class="dash-chart-label">${escapeHtml(max)}</text>
        </svg>${target !== null ? `<span class="dash-gauge-target-label">目标 ${escapeHtml(formatNumber(target, block.decimals))}${escapeHtml(block.unit || '')}</span>` : ''}</div>`;
    }

    function metricValue(block, result) {
        const columns = result.columns || [], rows = result.rows || [], key = block.value_column || columns[0];
        if (block.aggregate === 'count') return typeof result.total === 'number' ? result.total : rows.length;
        const values = rows.map(row => toNumber(cellValue(row, columns, key))).filter(value => value !== null);
        if (block.aggregate === 'sum') return values.reduce((sum, value) => sum + value, 0);
        if (block.aggregate === 'avg') return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        if (block.aggregate === 'max') return values.length ? Math.max(...values) : null;
        if (block.aggregate === 'min') return values.length ? Math.min(...values) : null;
        return values.length ? values[0] : cellValue(rows[0], columns, key);
    }

    function renderRanking(block, result) {
        const direction = block.sort && block.sort.direction === 'asc' ? 1 : -1;
        const data = seriesFrom(block, result)
            .sort((left, right) => (left.value - right.value) * direction)
            .slice(0, block.max_items || 10);
        if (!data.length) return emptyBody('没有可用于排名的数据');
        const max = Math.max(...data.map(item => item.value), 1);
        return `<div class="dash-ranking">${data.map((item, index) => `<div class="dash-ranking-row"><b>${index+1}</b><span>${escapeHtml(item.label)}</span><i><em style="width:${Math.max(3,item.value/max*100)}%"></em></i><strong>${escapeHtml(formatNumber(item.value, block.decimals))}</strong></div>`).join('')}</div>`;
    }

    function statusClass(value) {
        const text = String(value ?? '').toLowerCase();
        if (/严重|异常|失败|critical|error|down/.test(text)) return 'is-critical';
        if (/告警|警告|warning|warn|待处理/.test(text)) return 'is-warning';
        if (/正常|成功|online|success|ok|运行/.test(text)) return 'is-success';
        return 'is-neutral';
    }

    function renderStatus(block, result) {
        const columns = result.columns || [], rows = result.rows || [], key = block.status_column || block.value_column || columns[0];
        const value = cellValue(rows[0], columns, key);
        return `<div class="dash-status ${statusClass(value)}"><i></i><strong>${escapeHtml(value ?? '未知')}</strong><span>${escapeHtml(block.description || '当前运行状态')}</span></div>`;
    }

    function renderMetricGroup(block, result) {
        const data = multiSeriesFrom(block, result).series;
        return `<div class="dash-metric-group">${data.map(item => `<div><span>${escapeHtml(item.name)}</span><strong>${escapeHtml(formatNumber(item.values[0], block.decimals))}<small>${escapeHtml(block.unit || '')}</small></strong></div>`).join('')}</div>`;
    }

    function renderComparison(block, result) {
        const columns = result.columns || [], rows = result.rows || [];
        const current = toNumber(metricValue(block, result));
        const previous = toNumber(cellValue(rows[0], columns, block.compare_column));
        const currentText = current === null ? '-' : formatNumber(current, block.decimals);
        const previousText = previous === null ? '-' : formatNumber(previous, block.decimals);
        let deltaText = '暂无对比', trendClass = 'dash-trend--flat', arrow = '→';
        if (current !== null && previous !== null) {
            const delta = previous === 0 ? null : (current - previous) / Math.abs(previous) * 100;
            if (delta !== null) {
                arrow = delta > .05 ? '↑' : (delta < -.05 ? '↓' : '→');
                deltaText = `${arrow} ${Math.abs(delta).toFixed(1)}%`;
                if (block.trend === 'up_good') trendClass = delta > .05 ? 'dash-trend--good' : (delta < -.05 ? 'dash-trend--bad' : trendClass);
                if (block.trend === 'up_bad') trendClass = delta > .05 ? 'dash-trend--bad' : (delta < -.05 ? 'dash-trend--good' : trendClass);
            } else {
                deltaText = current === previous ? '→ 0.0%' : '基期为 0';
            }
        }
        const unit = escapeHtml(block.unit || '');
        return `<div class="dash-comparison">
            <div><span>当前值</span><strong>${escapeHtml(currentText)}<small>${unit}</small></strong></div>
            <div><span>对比值</span><strong>${escapeHtml(previousText)}<small>${unit}</small></strong></div>
            <em class="dash-metric-trend ${trendClass}">${escapeHtml(deltaText)}</em>
        </div>`;
    }

    function renderDynamicList(block, result, timeline) {
        const columns = result.columns || [], rows = (result.rows || []).slice(0, block.max_items || 12);
        if (!rows.length) return emptyBody('没有可展示的动态数据');
        const label = block.label_column || columns[0], detail = block.detail_column || columns[1], status = block.status_column || columns[2];
        const items = rows.map(row => {
            const title = cellValue(row, columns, label), note = cellValue(row, columns, detail), state = cellValue(row, columns, status);
            return `<div class="${timeline ? 'dash-timeline-item' : `dash-alert-item ${statusClass(state)}`}"><i></i><div><strong>${escapeHtml(title ?? '-')}</strong><span>${escapeHtml(note ?? '')}</span></div>${state != null ? `<em>${escapeHtml(state)}</em>` : ''}</div>`;
        }).join('');
        const moving = block.list_mode === 'marquee' && rows.length >= 4;
        const speed = clampInt(block.marquee_speed, 24, 4, 400);
        return `<div class="dash-dynamic-wrap${moving ? ' is-marquee' : ''}"${moving ? ` data-marquee="${escapeHtml(block.id)}" data-marquee-px="${speed}"` : ''}>
            <div class="${timeline ? 'dash-timeline' : 'dash-alert-list'}" data-marquee-track>${items}${moving ? items : ''}</div>
        </div>`;
    }

    function renderProgress(block, result) {
        const series = seriesFrom(block, result);
        if (!series.length) return emptyBody('没有可展示的数据');
        // 未指定基准时按最大值归一，保证条形有可比性。
        const base = toNumber(block.target_value) || toNumber(block.max_value) || Math.max(...series.map(item => item.value)) || 1;
        return series.slice(0, 12).map(item => {
            const percent = Math.max(0, Math.min(100, (item.value / base) * 100));
            return `<div class="dash-progress-row">
                <div class="dash-progress-label"><span>${escapeHtml(item.label)}</span><strong>${percent.toFixed(1)}%</strong></div>
                <div class="dash-progress-track"><div class="dash-progress-fill" style="width:${percent.toFixed(1)}%"></div></div>
            </div>`;
        }).join('');
    }

    function renderMetric(block, result) {
        const columns = result.columns || [];
        const rows = result.rows || [];
        const aggregate = block.aggregate || 'first';
        let value = null;

        if (aggregate === 'count') {
            value = typeof result.total === 'number' ? result.total : rows.length;
        } else {
            const valueKey = block.value_column || columns[0];
            const numbers = rows.map(row => toNumber(cellValue(row, columns, valueKey))).filter(num => num !== null);
            if (aggregate === 'first') value = numbers.length ? numbers[0] : cellValue(rows[0], columns, valueKey);
            else if (aggregate === 'sum') value = numbers.reduce((sum, num) => sum + num, 0);
            else if (aggregate === 'avg') value = numbers.length ? numbers.reduce((sum, num) => sum + num, 0) / numbers.length : null;
            else if (aggregate === 'max') value = numbers.length ? Math.max(...numbers) : null;
            else if (aggregate === 'min') value = numbers.length ? Math.min(...numbers) : null;
        }

        const numeric = toNumber(value);
        const display = numeric === null ? (value === null || value === undefined || value === '' ? '-' : escapeHtml(value)) : escapeHtml(formatNumber(numeric, block.decimals));
        let foot = '';

        // 对比列存在时给一个涨跌标记，方向好坏由配置决定（数量涨是好事，异常涨是坏事）。
        if (block.compare_column && numeric !== null) {
            const compare = toNumber(cellValue(rows[0], columns, block.compare_column));
            if (compare !== null && compare !== 0) {
                const delta = ((numeric - compare) / Math.abs(compare)) * 100;
                const rising = delta > 0.05;
                const falling = delta < -0.05;
                let cls = 'dash-trend--flat';
                if (block.trend === 'up_good') cls = rising ? 'dash-trend--good' : (falling ? 'dash-trend--bad' : 'dash-trend--flat');
                else if (block.trend === 'up_bad') cls = rising ? 'dash-trend--bad' : (falling ? 'dash-trend--good' : 'dash-trend--flat');
                const arrow = rising ? '↑' : (falling ? '↓' : '→');
                foot += `<span class="dash-metric-trend ${cls}">${arrow} ${Math.abs(delta).toFixed(1)}%</span>`;
                foot += `<span>对比 ${escapeHtml(formatNumber(compare, block.decimals))}</span>`;
            }
        }
        if (block.footnote) foot += `<span>${escapeHtml(block.footnote)}</span>`;

        return `<div class="dash-metric">
            <div class="dash-metric-value">${display}${block.unit ? `<span class="dash-metric-unit">${escapeHtml(block.unit)}</span>` : ''}</div>
            ${foot ? `<div class="dash-metric-foot">${foot}</div>` : ''}
        </div>`;
    }

    /** 表格一行的 HTML。lazy 模式追加行时也用它，保证追加出来的行和首屏一致。 */
    function tableRow(row, allColumns, showColumns) {
        // 这里始终写完整值，title 也是完整值；真正的截断在 syncTableColumns 里
        // 按定好的列宽用 fitCellText 逐格做（那时才知道每列有多少像素可用）。
        return `<tr>${showColumns.map(name => {
            const value = cellValue(row, allColumns, name);
            const display = value === null || value === undefined || value === '' ? '-' : String(value);
            return `<td title="${escapeHtml(display)}"><span class="dash-table-cell-text">${escapeHtml(display)}</span></td>`;
        }).join('')}</tr>`;
    }

    /* 表头单独一张表，摆在滚动框外面。
       为何不用 position:sticky：吸顶表头和行在同一个滚动框里，行是从表头"底下"滚过去的。
       表头只要不是不透明的，就能看见行在列名底下穿行（用户原话"行数据会穿过列，不要这样"）；
       而给它兑一层不透明底色，整块选「只留描边」时又是一条难看的实心横带。
       两个要求在同一个滚动框里没法同时满足，所以把表头挪出滚动框：
       行被滚动框的 overflow 裁掉，物理上进不到表头那一行，表头就能放心全透明。
       代价是两张表的列宽要对齐，靠 syncTableColumns() 量完再写死（见那个函数的注释）。 */
    function tableHead(showColumns, columnWidths) {
        const widths = columnWidths && typeof columnWidths === 'object' ? columnWidths : {};
        return `<div class="dash-table-headbox"><table class="dash-table dash-table-head"><thead><tr>${
            showColumns.map(name => {
                const width = clampInt(widths[name], 0, 60, 1200);
                return `<th${width ? ` data-column-width="${width}"` : ''} title="${escapeHtml(name)}"><span class="dash-table-cell-text">${escapeHtml(name)}</span></th>`;
            }).join('')}</tr></thead></table></div>`;
    }

    function renderTable(block, result) {
        const allColumns = result.columns || [];
        const rows = result.rows || [];
        if (!rows.length) return emptyBody('查询没有返回数据');
        const showColumns = (block.columns && block.columns.length ? block.columns.filter(name => allColumns.includes(name)) : allColumns);
        const mode = allow(block.table_mode, TABLE_MODES, 'paged');
        const pageSize = Math.max(1, Number(block.page_size) || 20);
        const total = typeof result.total === 'number' ? result.total : rows.length;
        const head = tableHead(showColumns, block.column_widths);

        // paged 之外的三种都要能看到全部取回的行，所以首屏渲染量不同：
        // scroll/marquee 一次全渲染（靠滚动看完），lazy 先渲染一批（滚到底再追加）。
        const shown = mode === 'paged' ? rows.slice(0, pageSize)
            : (mode === 'lazy' ? rows.slice(0, pageSize) : rows);
        const body = shown.map(row => tableRow(row, allColumns, showColumns)).join('');

        if (mode === 'marquee') {
            // 无缝循环靠内容渲染两遍 + tbody 上移 50%。行数太少时不值得滚，退回普通表格。
            // marquee_speed 现在是"每秒滚多少像素"，比原来的"每分钟多少行"直观：
            // 行高会随字号变，按行算速度换个字号就快慢不一了。
            const speed = clampInt(block.marquee_speed, 30, 4, 400);
            const loop = rows.length >= 4;
            // 渲染两遍才能无缝循环（滚过一半跳回 0，接上的正好是同样的内容）。
            const track = loop ? `<tbody>${body}${body}</tbody>` : `<tbody>${body}</tbody>`;
            // 滚动区域高度按行数给个上限，不然区块会被整表撑到很高。
            // 表头已经不在这个框里了，所以不再额外留表头那 38px。
            const height = Math.min(rows.length, Math.max(4, pageSize)) * 33;
            return `<div class="dash-table-box is-mode-marquee">${head}
                <div class="dash-table-wrap" style="max-height:${height}px"${loop ? ` data-marquee="${escapeHtml(block.id)}" data-marquee-px="${speed}"` : ''}>
                    <table class="dash-table dash-table-body">${track}</table>
                </div>
            </div><p class="dash-table-foot">共 ${total} 行，自动滚动中${result.truncated ? '（结果过多已截断）' : ''}（鼠标悬停暂停）</p>`;
        }

        if (mode === 'scroll' || mode === 'lazy') {
            const height = Math.max(4, pageSize) * 33;
            // 行数据挂在 DOM 上给滚动追加用：数据本来就已经在浏览器里了，
            // 存一份引用比每次滚动都回后端要快，也不会因为翻页触发重复查询。
            const key = `tbl_${block.id}`;
            tableCache[key] = { rows, allColumns, showColumns, columnWidths: block.column_widths || {}, next: shown.length, pageSize };
            const remain = rows.length - shown.length;
            const hint = mode === 'lazy' && remain > 0
                ? `<div class="dash-lazy-hint" data-lazy-hint="${escapeHtml(block.id)}"><i class="fa fa-angle-double-down"></i>向下滚动加载更多（还有 ${remain} 行）</div>`
                : '';
            return `<div class="dash-table-box is-mode-${mode}">${head}
                <div class="dash-table-wrap" style="max-height:${height}px" data-table-scroll="${escapeHtml(block.id)}" data-table-key="${escapeHtml(key)}">
                    <table class="dash-table dash-table-body"><tbody data-table-body="${escapeHtml(block.id)}">${body}</tbody></table>
                    ${hint}
                </div>
            </div><p class="dash-table-foot">共 ${total} 行${result.truncated ? '（结果过多已截断，可在SQL里加筛选条件）' : ''}</p>`;
        }

        const foot = total > shown.length
            ? `<p class="dash-table-foot">显示前 ${shown.length} 行，共 ${total} 行${result.truncated ? '（结果过多已截断）' : ''}</p>`
            : `<p class="dash-table-foot">共 ${total} 行</p>`;
        return `<div class="dash-table-box">${head}
            <div class="dash-table-wrap"><table class="dash-table dash-table-body"><tbody>${body}</tbody></table></div>
        </div>${foot}`;
    }

    /** 单元格完整内容所需宽度：Canvas 直接按真实字体量文字，不受表格当前压缩宽度影响。 */
    /** 单元格测量共用的 canvas 上下文，字体取自单元格真实计算样式。 */
    function cellTextContext(cell) {
        const style = window.getComputedStyle(cell);
        const canvas = tableCellNaturalWidth.canvas || (tableCellNaturalWidth.canvas = document.createElement('canvas'));
        const context = canvas.getContext('2d');
        if (context) context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
        return { context, style, letterSpacing: parseFloat(style.letterSpacing) || 0 };
    }

    /** 按可用像素宽度把文字截到放得下，末尾补省略号。
     *
     * 为何不只靠 CSS text-overflow：表头挪出滚动框后两张表各自 table-layout:fixed，
     * 部分浏览器对 table-cell 的 overflow 裁切不稳定，长文本会画到相邻列上（用户反复反馈
     * "内容会和其他列重叠"）。这里在文本层面就截断，是与浏览器无关的兜底。
     */
    function fitCellText(cell, available) {
        const holder = cell.querySelector('.dash-table-cell-text');
        if (!holder) return;
        const full = holder.dataset.fullText !== undefined ? holder.dataset.fullText : holder.textContent;
        holder.dataset.fullText = full;
        if (!full || available <= 0) { holder.textContent = full; return; }
        const { context, letterSpacing } = cellTextContext(cell);
        if (!context) { holder.textContent = full; return; }
        const measure = text => context.measureText(text).width + Math.max(0, text.length - 1) * letterSpacing;
        if (measure(full) <= available) { holder.textContent = full; return; }
        // 二分找最长能放下的前缀，比逐字符缩短快，长文本也只测 log(n) 次。
        let low = 0;
        let high = full.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (measure(`${full.slice(0, mid)}…`) <= available) low = mid; else high = mid - 1;
        }
        holder.textContent = low > 0 ? `${full.slice(0, low)}…` : '…';
    }

    function tableCellNaturalWidth(cell) {
        const text = cell.querySelector('.dash-table-cell-text');
        // 必须量完整值：重新同步时 DOM 里可能已经是上一轮截断过的文字，
        // 拿它当自然宽度会让列越量越窄。
        const value = text
            ? (text.dataset.fullText !== undefined ? text.dataset.fullText : text.textContent)
            : cell.textContent;
        const { context, style, letterSpacing } = cellTextContext(cell);
        const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
        if (!context) return Math.ceil((text ? text.scrollWidth : cell.scrollWidth) + padding + 1);
        return Math.ceil(context.measureText(value || '').width + Math.max(0, (value || '').length - 1) * letterSpacing + padding + 2);
    }

    /* 把表头那张表的列宽对到数据表上。
       为何必须量：表头挪出滚动框后是两张独立的表，各自按自己的内容分配列宽，
       "任务编码"那列在表头表里只有标题那么宽、在数据表里是一长串编号的宽度，
       不对齐就是列名和数据错位——比原来的穿行更难看。
       自动列扫描当前已渲染的每一行，按该列最长完整内容定宽；只测第一行会漏掉后面
       更长的编码。量完写进 colgroup 并切 table-layout:fixed，装不下时整体横向滚动。 */
    function syncTableColumns(box) {
        const headTable = box.querySelector('.dash-table-head');
        const bodyTable = box.querySelector('.dash-table-body');
        const wrap = box.querySelector('.dash-table-wrap');
        const headBox = box.querySelector('.dash-table-headbox');
        if (!headTable || !bodyTable || !wrap || !headBox) return;
        const bodyRows = bodyTable.querySelectorAll('tbody tr');
        const headCells = headTable.querySelectorAll('th');
        if (!bodyRows.length || !headCells.length) return;
        const firstCells = bodyRows[0].children;
        if (firstCells.length !== headCells.length) return;
        // 区块还没显示出来时 clientWidth 是 0，按 0 平分会把每列钉成 1px。
        // 直接放弃这次同步，等 ResizeObserver 在真正有宽度时再算。
        if (wrap.clientWidth <= 0) return;

        // 重新测量前必须同时移除旧 colgroup 和固定宽度；只改回 auto 仍会受旧列宽约束，
        // 全屏、预览放大或容器变宽后就不是真正的自适应。
        [headTable, bodyTable].forEach(table => {
            table.querySelector('colgroup')?.remove();
            table.style.tableLayout = 'auto';
            table.style.width = '';
            table.style.minWidth = '';
        });
        const hasConfiguredWidths = Array.from(headCells).some(cell =>
            clampInt(cell.dataset.columnWidth, 0, 60, 1200) > 0);
        const widths = [];
        const automatic = [];
        for (let i = 0; i < headCells.length; i++) {
            const configured = clampInt(headCells[i].dataset.columnWidth, 0, 60, 1200);
            if (configured) {
                widths.push(configured);
            } else {
                automatic.push(i);
                if (!hasConfiguredWidths) {
                    // 所有列都未配置时，业务优先级是“同屏看全所有列”，不是完整显示每个长值。
                    // 平分可视宽度，长内容由省略号处理，绝不通过横向扩宽把后面的列挤出屏幕。
                    widths.push(Math.max(1, Math.floor(wrap.clientWidth / headCells.length)));
                } else {
                    let width = tableCellNaturalWidth(headCells[i]);
                    bodyRows.forEach(row => {
                        if (row.children[i]) width = Math.max(width, tableCellNaturalWidth(row.children[i]));
                    });
                    widths.push(width);
                }
            }
        }
        // 只配了几列时，剩下的自动列按最长内容量出来往往加起来超过一屏，结果又要横向拉。
        // 业务优先级是「先看到所有列」：手填的宽度照给，自动列按比例压到剩余空间里，
        // 每列不低于 MIN_AUTO_COLUMN 以免压成看不出内容的窄条。压不进去才允许横向滚动。
        if (automatic.length && hasConfiguredWidths) {
            const MIN_AUTO_COLUMN = 56;
            const fixedTotal = widths.reduce((sum, width, index) =>
                sum + (automatic.includes(index) ? 0 : width), 0);
            const autoTotal = automatic.reduce((sum, index) => sum + widths[index], 0);
            const room = wrap.clientWidth - fixedTotal;
            if (autoTotal > room && room >= automatic.length * MIN_AUTO_COLUMN) {
                const ratio = room / autoTotal;
                automatic.forEach(index => {
                    widths[index] = Math.max(MIN_AUTO_COLUMN, Math.floor(widths[index] * ratio));
                });
            }
        }
        const measuredWidth = widths.reduce((sum, width) => sum + width, 0);
        // 自动列压缩过之后不能再拿 auto 布局下量到的表宽当目标：那是「没压缩」的宽度，
        // 用它算 targetWidth 会把刚压掉的空间又加回来，横向滚动照旧出现。
        const naturalWidth = hasConfiguredWidths ? measuredWidth : wrap.clientWidth;
        // 表格比容器窄时把余量分给未手工配置的列；宽度统一取整，吸收折叠边框和
        // 小数像素误差，避免表头表与数据表在最右侧差一个像素。
        // 以数据滚动区的可视宽度为准，不能取表头容器宽度：传统滚动条会占掉
        // 数据区十几像素，按表头宽度铺表就会让最后一列落到滚动条下面。
        const targetWidth = Math.ceil(Math.max(naturalWidth, wrap.clientWidth));
        const spare = Math.max(0, targetWidth - measuredWidth);
        // 余量只分给自动列；每列都手填时保持用户给出的总宽，装不下就横向滚动。
        // 不能再把余量强塞给最后一列，否则用户配置的最后一列宽度又会被自动逻辑覆盖。
        if (spare && automatic.length) {
            const each = Math.floor(spare / automatic.length);
            let remainder = spare - each * automatic.length;
            automatic.forEach(index => {
                widths[index] += each + (remainder > 0 ? 1 : 0);
                remainder = Math.max(0, remainder - 1);
            });
        }
        const tableWidth = widths.reduce((sum, width) => sum + width, 0);
        const cols = `<colgroup>${widths.map(width => `<col style="width:${width}px">`).join('')}</colgroup>`;
        [headTable, bodyTable].forEach(table => {
            table.insertAdjacentHTML('afterbegin', cols);
            table.style.tableLayout = 'fixed';
            table.style.width = `${tableWidth}px`;
            table.style.minWidth = `${tableWidth}px`;
        });
        // Safari/部分 Chromium 对 table-cell 的 overflow 裁切不稳定，给文字容器明确内容宽度，
        // 彻底阻止长文本画进下一列。宽度扣掉左右 padding，并至少保留 1px。
        const applyCell = (cell, index) => {
            const text = cell.querySelector('.dash-table-cell-text');
            if (!widths[index]) return;
            const contentWidth = Math.max(1, widths[index] - 18);
            cell.style.width = `${widths[index]}px`;
            cell.style.minWidth = `${widths[index]}px`;
            cell.style.maxWidth = `${widths[index]}px`;
            if (text) text.style.width = `${contentWidth}px`;
            // 定好列宽后按真实像素截字：CSS 省略号在两张固定布局表上不总生效。
            fitCellText(cell, contentWidth);
        };
        headCells.forEach(applyCell);
        bodyRows.forEach(row => Array.from(row.children).forEach(applyCell));
        // 表格重算总宽后，浏览器可能保留上一次的 scrollLeft。首次同步强制从最左开始；
        // 后续 ResizeObserver 重算则保留用户正在看的位置，并把表头校正到同一位置。
        if (wrap.dataset.widthSynced !== '1') {
            wrap.scrollLeft = 0;
            wrap.dataset.widthSynced = '1';
        }
        headBox.scrollLeft = wrap.scrollLeft;
        // 横向滚动时表头要跟着走，否则一往右拉列名就和数据错开。
        if (wrap.dataset.headSync !== '1') {
            wrap.dataset.headSync = '1';
            wrap.addEventListener('scroll', () => {
                headBox.scrollLeft = wrap.scrollLeft;
            });
        }
        // 宽屏切换、全屏和浏览器缩放都会改变区块宽度，变化后重新按内容和容器计算。
        if (!box._dashTableResizeObserver && window.ResizeObserver) {
            let previousWidth = box.clientWidth;
            box._dashTableResizeObserver = new ResizeObserver(() => {
                const currentWidth = box.clientWidth;
                if (!box.isConnected) { box._dashTableResizeObserver.disconnect(); return; }
                if (Math.abs(currentWidth - previousWidth) < 1) return;
                previousWidth = currentWidth;
                requestAnimationFrame(() => syncTableColumns(box));
            });
            box._dashTableResizeObserver.observe(box);
        }
    }

    /* lazy 模式首屏必须撑出可滚距离，否则一行都追加不出来。
       为何会撑不出来：可视高度按"每行 33px"折算，但真实行高跟着字号变——
       表格文字选「很小」时一行只有 27px，pageSize 行加起来比可视高度还矮，
       overflow 没溢出 → 滚不动 → scroll 事件永不触发 → 选了滚动加载却一行都不追加。
       实测 cell=xs 时 12 行/20 行的可滚距离都是 0，就是用户说的"滚动加载还是没生效"。
       这里渲染完先补几批到真的能滚为止；补的批次上限防止行特别矮时把整份数据一次灌进来。 */
    function fillUntilScrollable(wrap) {
        const cache = tableCache[wrap.dataset.tableKey];
        if (!cache) return;
        for (let guard = 0; guard < 20; guard++) {
            if (wrap.scrollHeight - wrap.clientHeight > 40) return;
            if (cache.next >= cache.rows.length) return;
            if (!appendNextBatch(wrap, cache)) return;
        }
    }

    /** 追加下一批行；返回是否真的追加了。lazy 的滚动触发和首屏补足共用。 */
    function appendNextBatch(wrap, cache) {
        const body = wrap.querySelector('[data-table-body]');
        if (!body) return false;
        const batch = cache.rows.slice(cache.next, cache.next + cache.pageSize);
        if (!batch.length) return false;
        body.insertAdjacentHTML('beforeend',
            batch.map(row => tableRow(row, cache.allColumns, cache.showColumns)).join(''));
        cache.next += batch.length;
        const hint = wrap.querySelector('[data-lazy-hint]');
        if (hint) {
            const remain = cache.rows.length - cache.next;
            if (remain > 0) hint.innerHTML = `<i class="fa fa-angle-double-down"></i>向下滚动加载更多（还有 ${remain} 行）`;
            else hint.remove();
        }
        // 新批次可能出现更长内容，自动列要按新增行重新计算；手工列宽仍会保持原值。
        const box = wrap.closest('.dash-table-box');
        if (box) syncTableColumns(box);
        return true;
    }

    // 滚动加载用的行缓存：key -> {rows, allColumns, showColumns, next, pageSize}。
    // 每次重渲染会覆盖同 key 的条目，所以不会随刷新次数增长。
    const tableCache = {};

    /** 渲染完成后调用：对齐两张表的列宽，并绑定"滚到底追加下一批"。重复调用安全。 */
    function bindTableScroll(root) {
        const scope = root || document;
        // 列宽对齐对所有模式都要做（表头都在滚动框外面），所以按 box 遍历，不是按可滚动的框。
        scope.querySelectorAll('.dash-table-box').forEach(syncTableColumns);
        scope.querySelectorAll('[data-table-scroll]').forEach(wrap => {
            if (wrap.dataset.scrollBound === '1') return;
            wrap.dataset.scrollBound = '1';
            wrap.addEventListener('scroll', () => {
                const cache = tableCache[wrap.dataset.tableKey];
                if (!cache || cache.next >= cache.rows.length) return;
                // 提前 40px 触发，滚到底之前下一批就已经接上了，看不到空白。
                if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 40) return;
                appendNextBatch(wrap, cache);
            });
            // 绑完立刻补到能滚为止：没有可滚距离的话上面这个监听一辈子不会触发。
            fillUntilScrollable(wrap);
        });
    }

    // 正在跑的匀速滚动：key 是区块 id，值是 rAF 句柄。重渲染时要先停掉旧的，
    // 否则同一块上会叠着好几个循环，越滚越快。
    const marqueeTimers = {};

    /** 停掉某一块（或全部）的匀速滚动。 */
    function stopMarquee(id) {
        const keys = id ? [id] : Object.keys(marqueeTimers);
        keys.forEach(k => {
            if (marqueeTimers[k]) cancelAnimationFrame(marqueeTimers[k]);
            delete marqueeTimers[k];
        });
    }

    /**
     * 匀速滚动改用 JS 逐帧改 scrollTop。
     * 为何不用 CSS 动画：原来是给 <tbody> 加 transform:translateY(-50%)，
     * 但 table-row-group 上的 transform 各浏览器支持不一致（不少环境直接不动），
     * 这就是"选了自动匀速滚动却看不到效果"的原因。改滚容器的 scrollTop 到处都稳，
     * 而且表头的 position:sticky 还能继续生效。
     */
    function bindMarquee(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-marquee]').forEach(wrap => {
            const id = wrap.dataset.marquee;
            stopMarquee(id);
            /* 等两帧再量尺寸：innerHTML 刚写完、预览弹层刚展开或浏览器刚退出后台时，
               首次读到的 clientHeight/scrollHeight 可能还是 0，立即判定就会永久退出，
               表现为配置了自动滚动却一动不动。自动滚动是用户明确选择的数据展示方式，
               不是装饰动画，因此不能因为系统动画偏好而静默关闭。 */
            let waitFrames = 2;
            const start = () => {
                if (!wrap.isConnected) { stopMarquee(id); return; }
                if (waitFrames > 0) {
                    waitFrames -= 1;
                    marqueeTimers[id] = requestAnimationFrame(start);
                    return;
                }

            /* 一圈的长度 = 一份内容（tbody 的一半）的高度，不是 scrollHeight/2。
               scrollHeight 还含着 thead，用 scrollHeight/2 会比真正的接缝早半个表头高度，
               每圈都可见地"跳"一下（表头字号越大跳得越明显）。 */
            const body = wrap.querySelector('tbody');
            const track = wrap.querySelector('[data-marquee-track]');
            const loopLen = () => (body ? body.offsetHeight / 2 : (track ? track.offsetHeight / 2 : wrap.scrollHeight / 2));
            if (loopLen() <= 4) return;
            // 一屏就装得下时不用滚。这里比的是可滚动距离，不是一圈长度。
            if (wrap.scrollHeight <= wrap.clientHeight + 4) return;

            const pxPerSec = Math.max(4, Number(wrap.dataset.marqueePx) || 30);
            let last = 0;
            let paused = false;
            /* 位置必须自己用浮点数记，不能每帧把 scrollTop 读回来当累加基准：
               浏览器会把 scrollTop 吸附到整像素，每帧增量不到 0.5px 时一律归 0，
               读回来永远是 0，于是"选了自动滚动却一动不动"。
               实测每帧 +0.4 连续 6 帧读回全是 0；+0.5 才开始走。
               而默认 30px/秒 在 60Hz 上正好是 0.5px/帧 卡在临界点，
               120Hz 屏（近几年的 Mac、不少大屏）只有 0.25px/帧，直接死住。
               换成浮点累加后，速度慢也只是走得慢，不会一步都不走。 */
            let pos = 0;
            wrap.addEventListener('mouseenter', () => { paused = true; });
            wrap.addEventListener('mouseleave', () => { paused = false; });

            const step = now => {
                if (!wrap.isConnected) { stopMarquee(id); return; }
                if (!last) last = now;
                // 标签页切走再切回来时 now 会跳很大一截，夹住 dt 免得一帧滚过好几屏。
                const dt = Math.min((now - last) / 1000, 0.25);
                last = now;
                if (!paused && !document.hidden) {
                    const len = loopLen();
                    pos += pxPerSec * dt;
                    if (len > 0) { while (pos >= len) pos -= len; }
                    // 只在跨过整像素时才写 scrollTop：写同一个整数不会触发重排，
                    // 但显式判一下更清楚"慢速时是攒够 1px 再走一格"。
                    const px = Math.round(pos);
                    if (px !== wrap.scrollTop) wrap.scrollTop = px;
                }
                marqueeTimers[id] = requestAnimationFrame(step);
            };
            marqueeTimers[id] = requestAnimationFrame(step);
            };
            marqueeTimers[id] = requestAnimationFrame(start);
        });
    }

    function emptyBody(message) {
        return `<div class="dash-block-nodata"><i class="fa fa-inbox"></i>${escapeHtml(message)}</div>`;
    }

    let clockTimer = 0;

    function updateClocks(scope) {
        if (document.hidden) return;
        (scope || document).querySelectorAll('[data-dashboard-clock]').forEach(clock => {
            const now = new Date();
            const format = clock.dataset.dashboardClock || 'datetime';
            const date = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
            const time = now.toLocaleTimeString('zh-CN', { hour12: false });
            clock.innerHTML = `${format !== 'date' ? `<strong>${escapeHtml(time)}</strong>` : ''}${format !== 'time' ? `<span>${escapeHtml(date)}</span>` : ''}`;
        });
    }

    /** 时钟每秒扫描当前文档，避免定时器一直引用已被重绘移除的旧预览节点。 */
    function bindClocks(root) {
        updateClocks(root || document);
        if (!clockTimer) clockTimer = window.setInterval(() => updateClocks(document), 1000);
    }

    function renderBlockBody(block, payload) {
        if (block.type === 'text' || block.type === 'section') return `<div class="${block.type === 'section' ? 'dash-section-block' : 'dash-text-block'}">${escapeHtml(block.body || block.description || '')}</div>`;
        if (block.type === 'clock') {
            return `<div class="dash-clock" data-dashboard-clock="${escapeHtml(block.clock_format || 'datetime')}"></div>`;
        }
        if (!payload) return '<div class="dash-block-loading"><i class="fa fa-spinner fa-spin"></i>加载中…</div>';
        if (!payload.success) return `<div class="dash-block-error"><i class="fa fa-exclamation-triangle"></i><span>${escapeHtml(payload.error || '区块执行失败')}</span></div>`;

        const result = payload.result || {};
        try {
            if (block.type === 'metric') return renderMetric(block, result);
            if (block.type === 'comparison') return renderComparison(block, result);
            if (block.type === 'metric_group') return renderMetricGroup(block, result);
            if (block.type === 'gauge') return renderGauge(block, result);
            if (block.type === 'ranking') return renderRanking(block, result);
            if (block.type === 'status') return renderStatus(block, result);
            if (block.type === 'table') return renderTable(block, result);
            if (block.type === 'progress') return renderProgress(block, result);
            if (block.type === 'grouped_bar' || block.type === 'stacked_bar') return renderMultiBar(block, result);
            if (block.type === 'bar') return (block.value_columns || []).length > 1 ? renderMultiBar(block, result) : renderBar(seriesFrom(block, result));
            if (block.type === 'line' || block.type === 'area') return renderMultiLine(block, result);
            if (block.type === 'pie') return renderPie(seriesFrom(block, result), block);
            if (block.type === 'alert_list') return renderDynamicList(block, result, false);
            if (block.type === 'timeline') return renderDynamicList(block, result, true);
        } catch (error) {
            return `<div class="dash-block-error"><i class="fa fa-exclamation-triangle"></i><span>渲染失败: ${escapeHtml(error.message || error)}</span></div>`;
        }
        return emptyBody('未知的展示方式');
    }

    // ---------- 看板查看端 ----------

    /** 看板独立页地址：可直接分享、可收藏。 */
    function dashboardUrl(dashboardId) {
        return `${window.location.origin}/dashboard/${encodeURIComponent(dashboardId)}`;
    }

    function renderGallery() {
        const grid = el('dashboardCardGrid');
        const empty = el('dashboardEmpty');
        const count = el('dashboardCount');
        if (!grid) return;
        if (count) count.textContent = `${dashboardSummaries.length} 个看板`;

        if (!dashboardSummaries.length) {
            grid.innerHTML = '';
            if (empty) empty.classList.remove('hidden');
            return;
        }
        if (empty) empty.classList.add('hidden');
        grid.innerHTML = dashboardSummaries.map(item => {
            const desc = item.description || '还没写说明，点开看看里面有什么。';
            const refresh = Number(item.refresh_seconds) || 0;
            const refreshText = refresh >= 30 ? `每 ${refresh} 秒自动刷新` : '手动刷新';
            const theme = item.theme || 'aurora';
            // 用 <a target="_blank"> 而不是 button+JS：中键/右键「在新窗口打开」这些浏览器原生操作都能用。
            return `<a class="dash-tile dash-theme-${escapeHtml(theme)}" href="${escapeHtml(dashboardUrl(item.id))}"
                target="_blank" rel="noopener" data-dashboard-open="${escapeHtml(item.id)}" title="在新窗口打开「${escapeHtml(item.name)}」">
                <span class="dash-tile-cover" aria-hidden="true">
                    ${item.bg_image ? (item.bg_is_video
                        ? `<video class="dash-tile-photo" src="/api/custom_dashboards/assets/${encodeURIComponent(item.bg_image)}/raw" muted loop autoplay playsinline preload="metadata" tabindex="-1" aria-hidden="true"></video>`
                        : `<span class="dash-tile-photo" style="background-image:url('/api/custom_dashboards/assets/${encodeURIComponent(item.bg_image)}/raw')"></span>`) : ''}
                    <span class="dash-tile-orb"></span>
                    <span class="dash-tile-bars"><i></i><i></i><i></i><i></i><i></i></span>
                    <span class="dash-tile-icon"><i class="fa fa-th-large"></i></span>
                </span>
                <span class="dash-tile-body">
                    <span class="dash-tile-name">${escapeHtml(item.name)}</span>
                    <span class="dash-tile-desc">${escapeHtml(desc)}</span>
                    <span class="dash-tile-meta">
                        <span><i class="fa fa-clone"></i>${Number(item.block_count) || 0} 个内容块</span>
                        <span><i class="fa fa-refresh"></i>${escapeHtml(refreshText)}</span>
                        ${item.public ? '<span class="dash-tile-public"><i class="fa fa-globe"></i>免登录</span>' : ''}
                    </span>
                </span>
                <span class="dash-tile-foot">
                    <span class="dash-tile-foot-main">在新窗口打开<i class="fa fa-external-link ml-1.5"></i></span>
                    <span class="dash-tile-acts">
                        <span class="dash-tile-act" data-dashboard-copy="${escapeHtml(item.id)}" title="复制看板地址"><i class="fa fa-link"></i></span>
                        ${item.can_manage ? `<span class="dash-tile-act" data-dashboard-json="${escapeHtml(item.id)}" title="复制看板JSON（可导入其他项目）"><i class="fa fa-code"></i></span>
                        <span class="dash-tile-act" data-dashboard-edit="${escapeHtml(item.id)}" title="编辑看板"><i class="fa fa-pencil"></i></span>
                        <span class="dash-tile-act is-danger" data-dashboard-delete="${escapeHtml(item.id)}" title="删除看板"><i class="fa fa-trash-o"></i></span>` : ''}
                    </span>
                </span>
            </a>`;
        }).join('');
    }

    /** 复制看板地址；clipboard 在非 HTTPS 下不可用时退回 prompt 让人手动复制。 */
    async function copyDashboardUrl(dashboardId) {
        const url = dashboardUrl(dashboardId);
        try {
            await navigator.clipboard.writeText(url);
            toast('看板地址已复制，可以直接发给同事', 'success');
        } catch (error) {
            window.prompt('复制这个看板的地址：', url);
        }
    }

    /** 复制看板 JSON：只带脚本名称，不带 SQL，便于其他项目粘贴导入。 */
    async function copyDashboardJson(dashboardId) {
        try {
            const response = await fetch(`/api/custom_dashboards/${encodeURIComponent(dashboardId)}/export`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '导出看板JSON失败');
            const text = JSON.stringify(data.dashboard_json, null, 2);
            try {
                await navigator.clipboard.writeText(text);
                toast('看板JSON已复制，到其他项目点「导入JSON」粘贴即可', 'success');
            } catch (error) {
                window.prompt('复制这段看板JSON：', text);
            }
        } catch (error) {
            toast(error.message || '导出看板JSON失败', 'error');
        }
    }

    /** 导入看板 JSON：按脚本名称匹配本项目脚本，匹配不到的区块保留但需重选。 */
    async function importDashboardJson() {
        const text = window.prompt('粘贴看板JSON（从其他项目的「复制看板JSON」得到）：', '');
        if (!text || !text.trim()) return;
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (error) {
            toast('JSON 格式不对，检查一下是否复制完整', 'error');
            return;
        }
        try {
            const response = await fetch('/api/custom_dashboards/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dashboard_json: payload }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '导入看板失败');
            const unmatched = data.unmatched_scripts || [];
            toast(unmatched.length
                ? `已导入，但这些脚本本项目没有，需要在编辑里重选：${unmatched.join('、')}`
                : '看板已导入', unmatched.length ? 'warning' : 'success');
            await loadDashboards();
            if (data.dashboard && data.dashboard.id) await openEditorFor(data.dashboard.id);
        } catch (error) {
            toast(error.message || '导入看板失败', 'error');
        }
    }

    function blockShell(block, payload) {
        const width = Math.max(1, Math.min(GRID_COLUMNS, block.layout && block.layout.w ? block.layout.w : 6));
        // v2 直接保存像素高度；旧 layout.h 仍按 92px/档兼容折算。
        const legacyHeight = Math.max(1, block.layout && block.layout.h ? block.layout.h : 2) * 92;
        const minHeight = clampInt(block.layout && block.layout.height_px, Math.max(120, legacyHeight), 120, 1600);
        const noScript = block.type === 'text' || block.type === 'section' || block.type === 'clock';
        const reload = noScript ? '' :
            `<button type="button" class="dash-block-reload" data-reload-block="${escapeHtml(block.id)}" title="只刷新这一块"><i class="fa fa-refresh"></i></button>`;
        // 自定义配色通过 CSS 变量下发，样式表里用 var(--block-x, 主题色) 兜底，
        // 这样"不选颜色"就是跟随主题，不用在 JS 里到处拼 style。
        const vars = [
            ['--block-title', block.title_color],
            ['--block-value', block.value_color],
            ['--block-accent', block.accent_color],
            ['--block-head', block.header_color],
            ['--block-cell', block.cell_color],
            ['--block-bg', block.bg_preset === 'custom' ? block.bg_color : ''],
        ].map(([name, value]) => (safeColor(value) ? `${name}:${safeColor(value)};` : '')).join('');
        // 手输字号：只有填了非 0 才内联，否则留给档位 class 决定。
        // clampInt 上限跟后端 _int 对齐，防止拼出 font-size:99999px 把布局撑爆。
        const pxVars = [
            ['--block-title-px', clampInt(block.title_px, 0, 0, 200)],
            ['--block-value-px', clampInt(block.value_px, 0, 0, 400)],
            ['--block-head-px', clampInt(block.header_px, 0, 0, 200)],
            ['--block-cell-px', clampInt(block.cell_px, 0, 0, 200)],
        ].map(([name, value]) => (value > 0 ? `${name}:${value}px;` : '')).join('');
        // 底色透明度按 0~1 传，CSS 里用 calc 乘到各预设自己的基准透明度上。
        const opacity = clampInt(block.bg_opacity, 100, 10, 100) / 100;
        const bg = allow(block.bg_preset, BLOCK_BACKGROUNDS, 'theme');
        // 样式全部走 class，不拼具体数值：数值拼进 style 就得逐处校验，class 名是白名单里的枚举。
        const styleClasses = [
            bg !== 'theme' ? `is-bg-${bg}` : '',
            `is-title-${allow(block.title_size, TITLE_SIZES, 'md')}`,
            `is-value-${allow(block.value_size, VALUE_SIZES, 'xl')}`,
            block.type === 'table' ? `is-head-${allow(block.header_size, TABLE_SIZES, 'md')}` : '',
            block.type === 'table' ? `is-cell-${allow(block.cell_size, TABLE_SIZES, 'md')}` : '',
        ].filter(Boolean).join(' ');
        const titleAlign = allow(block.title_align, ALIGNS, 'left');
        const valueAlign = allow(block.value_align, ALIGNS, 'left');
        return `<div class="dash-block ${styleClasses}" style="--block-grid-span:${width};grid-column:span ${width};height:${minHeight}px;${vars}${pxVars}--block-bg-a:${opacity};" data-block-id="${escapeHtml(block.id)}">
            <div class="dash-block-head${titleAlign !== 'left' ? ` is-align-${titleAlign}` : ''}">
                <div class="min-w-0">
                    <div class="dash-block-title">${escapeHtml(block.title || '未命名')}</div>
                    ${block.description && block.type !== 'text' ? `<div class="dash-block-desc">${escapeHtml(block.description)}</div>` : ''}
                </div>
                ${reload}
            </div>
            <div class="dash-block-body${valueAlign !== 'left' ? ` is-align-${valueAlign}` : ''}" data-block-body="${escapeHtml(block.id)}">${renderBlockBody(block, payload)}</div>
        </div>`;
    }

    async function openEditorFor(dashboardId) {
        try {
            const response = await fetch(`/api/custom_dashboards/${encodeURIComponent(dashboardId)}`);
            const data = await response.json();
            if (!data.success) { toast(data.error || '看板加载失败', 'error'); return; }
            if (data.can_manage === false) { toast('没有该看板的管理权限，无法编辑', 'warning'); return; }
            await loadScriptCatalog(true, dashboardId);
            openEditor(data.dashboard);
        } catch (error) {
            toast(`看板加载失败: ${error.message || error}`, 'error');
        }
    }

    async function loadDashboards() {
        try {
            const response = await fetch('/api/custom_dashboards');
            const data = await response.json();
            if (!data.success) { toast(data.error || '看板列表加载失败', 'error'); return; }
            dashboardSummaries = data.dashboards || [];
            // 新建权限（can_create）与逐看板管理权限（item.can_manage）分开：
            // 只被授权管理某几个看板的人不能新建，但要能编辑那几个。
            canManage = Boolean(data.can_create);
            applyManagePermission();
            renderGallery();
        } catch (error) {
            toast(`看板列表加载失败: ${error.message || error}`, 'error');
        }
    }

    /** 无「配置」权限时藏掉新建/编辑/删除，避免非授权用户点了才报错。 */
    function applyManagePermission() {
        ['dashboardCreateBtn', 'dashboardImportBtn', 'dashboardEditBtn', 'dashboardDeleteBtn'].forEach(id => {
            el(id)?.classList.toggle('hidden', !canManage);
        });
    }

    async function loadScriptCatalog(force, dashboardId) {
        // 自定义SQL 随时可能新增脚本，默认每次打开配置器都重新拉一次，
        // 否则新存的脚本在下拉里选不到（必须刷新整页才出现）。
        if (scriptCatalog.length && !force) return scriptCatalog;
        // 带上 dashboard_id：只被授权管理某几个看板的人凭该看板的管理权限取脚本目录。
        const query = dashboardId ? `?dashboard_id=${encodeURIComponent(dashboardId)}` : '';
        try {
            const response = await fetch(`/api/custom_dashboards/scripts${query}`);
            const data = await response.json();
            scriptCatalog = data.success ? (data.scripts || []) : [];
        } catch (error) {
            scriptCatalog = [];
        }
        return scriptCatalog;
    }

    async function deleteDashboard(dashboardId) {
        const summary = dashboardSummaries.find(item => String(item.id) === String(dashboardId));
        const name = summary ? summary.name : '该看板';
        const confirmed = typeof window.showConfirm === 'function'
            ? await window.showConfirm(`确定删除看板「${name}」吗？删除后无法恢复（引用的SQL脚本不受影响）。`)
            : window.confirm(`确定删除看板「${name}」吗？`);
        if (!confirmed) return;
        try {
            const response = await fetch(`/api/custom_dashboards/${encodeURIComponent(dashboardId)}`, { method: 'DELETE' });
            const data = await response.json();
            if (!data.success) { toast(data.error || '删除失败', 'error'); return; }
            toast(`看板「${name}」已删除`, 'success');
            await loadDashboards();
        } catch (error) {
            toast(`删除失败: ${error.message || error}`, 'error');
        }
    }

    // ---------- 向导式配置器 ----------

    function newBlockId() {
        return `blk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    }

    function selectOptions(options, selected) {
        return options.map(option => {
            const value = typeof option === 'string' ? option : option.value;
            const label = typeof option === 'string' ? option : option.label;
            return `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
    }

    /**
     * 宽度下拉的选项。
     *
     * 布局条拖出来的宽度可能不在预设里（比如 5/12），
     * 那就把这个值临时插成一个选项，否则下拉框会显示成第一项，
     * 看起来跟布局条上的宽度不一致。
     */
    function widthOptions(current) {
        const width = Math.max(1, Math.min(GRID_COLUMNS, Number(current) || 6));
        if (WIDTH_PRESETS.some(preset => preset.value === width)) return selectOptions(WIDTH_PRESETS, width);
        const merged = WIDTH_PRESETS.concat([{ value: width, label: `拖出来的宽度（${width}/12）` }])
            .sort((a, b) => a.value - b.value);
        return selectOptions(merged, width);
    }

    const INPUT_CLASS = 'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 transition-all';
    const INPUT_STYLE = 'style="--tw-ring-color: var(--primary-color);"';

    function field(label, control, hint) {
        return `<div><label class="block text-xs font-medium text-gray-700 mb-1">${escapeHtml(label)}</label>${control}${hint ? `<p class="dash-hint">${escapeHtml(hint)}</p>` : ''}</div>`;
    }

    /**
     * 字号字段：档位下拉 + 手输 px 一行摆开。
     * 为何两个都留：档位是"选了就好看"的省事路径，px 给挂大屏时精确对齐用。
     * px 填 0/留空就回到档位，不用额外加"使用档位"的开关。
     */
    function sizeField(label, index, sizeKey, sizeOptions, sizeList, sizeDefault, pxKey, pxMax, block, hint) {
        const px = clampInt(block[pxKey], 0, 0, pxMax);
        return field(label, `<div class="dash-size-row">
            <select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="${sizeKey}">${selectOptions(sizeOptions, allow(block[sizeKey], sizeList, sizeDefault))}</select>
            <input type="number" min="0" max="${pxMax}" placeholder="px" title="自己输入字号（像素），留空或 0 就用左边的档位"
                class="${INPUT_CLASS} dash-size-px" ${INPUT_STYLE} data-block-index="${index}" data-field="${pxKey}" value="${px > 0 ? px : ''}">
        </div>`, hint);
    }

    function typePicker(block, index) {
        return BLOCK_TYPES.map(type => `<button type="button" class="dash-type-option${block.type === type.value ? ' is-active' : ''}" data-block-index="${index}" data-set-type="${type.value}" title="${escapeHtml(type.hint)}">
            <i class="fa ${type.icon}"></i>${escapeHtml(type.label)}
        </button>`).join('');
    }

    function scriptSelectOptions(selected) {
        const grouped = new Map();
        scriptCatalog.forEach(script => {
            const category = script.category || '未分类';
            if (!grouped.has(category)) grouped.set(category, []);
            grouped.get(category).push(script);
        });
        let html = `<option value="">请选择一个已保存的SQL脚本…</option>`;
        grouped.forEach((scripts, category) => {
            html += `<optgroup label="${escapeHtml(category)}">`;
            html += scripts.map(script => `<option value="${escapeHtml(script.id)}"${script.id === selected ? ' selected' : ''}>${escapeHtml(script.name)}</option>`).join('');
            html += '</optgroup>';
        });
        return html;
    }

    /** 区块编辑卡：类型 → 脚本 → 列映射 → 尺寸，按依赖顺序往下展开。 */
    /**
     * 一个配色位的选择器：跟随主题 + 色块点选 + 手填十六进制。
     *
     * 三种入口都写同一个字段：色块和「跟随主题」用 data-color-set 走点击，
     * 输入框走 data-field 的常规 change 流程，非开发人员点色块就够了。
     */
    function colorPicker(block, index, config) {
        const current = safeColor(block[config.key]);
        const swatches = COLOR_SWATCHES.map(color => `
            <button type="button" class="dash-swatch${current === color ? ' is-on' : ''}"
                style="background:${color}" title="${color}"
                data-color-set="${color}" data-color-key="${config.key}" data-block-index="${index}"></button>`).join('');
        return `<div class="dash-color-row">
            <div class="dash-color-head">
                <span class="dash-color-label">${escapeHtml(config.label)}</span>
                <button type="button" class="dash-color-reset${current ? '' : ' is-on'}"
                    data-color-set="" data-color-key="${config.key}" data-block-index="${index}">跟随主题</button>
            </div>
            <div class="dash-swatch-row">${swatches}</div>
            <div class="dash-color-custom">
                <span class="dash-color-chip" style="background-color:${current || 'transparent'}"></span>
                <input type="text" maxlength="7" class="${INPUT_CLASS}" ${INPUT_STYLE}
                    data-block-index="${index}" data-field="${config.key}" value="${escapeHtml(current)}"
                    placeholder="留空跟随主题，或填 #38bdf8">
            </div>
            <p class="dash-hint">${escapeHtml(config.hint)}</p>
        </div>`;
    }

    /**
     * 外观设置：底色 + 文字位置 + 字号。
     *
     * 按块类型给不同选项：表格没有大号数字，指标没有表头，
     * 全都摆出来会让人不知道该动哪个。
     */
    function styleFields(block, index) {
        const bg = allow(block.bg_preset, BLOCK_BACKGROUNDS, 'theme');
        let html = field('这一块的底色',
            `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="bg_preset">${selectOptions(BG_PRESET_OPTIONS, bg)}</select>`,
            '深色主题配「毛玻璃」，浅色主题配「磨砂白」，加了背景图配「深色玻璃」最清楚。');

        if (bg === 'custom') {
            html += field('自定义底色',
                `<div class="dash-color-custom">
                    <span class="dash-color-chip" style="background-color:${safeColor(block.bg_color) || 'transparent'}"></span>
                    <input type="text" maxlength="7" class="${INPUT_CLASS}" ${INPUT_STYLE}
                        data-block-index="${index}" data-field="bg_color" value="${escapeHtml(safeColor(block.bg_color))}" placeholder="#0f172a">
                </div>`,
                '填十六进制色值，比如 #0f172a。');
        }
        if (bg !== 'theme' && bg !== 'outline') {
            html += field('底色不透明度',
                `<input type="number" min="10" max="100" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="bg_opacity" value="${escapeHtml(block.bg_opacity === undefined ? 100 : block.bg_opacity)}">`,
                '100 是完全不透明。调小一点能透出后面的背景，配背景图时好看。');
        }

        html += field('标题位置',
            `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="title_align">${selectOptions(ALIGN_OPTIONS, allow(block.title_align, ALIGNS, 'left'))}</select>`, '');
        html += sizeField('标题字号', index, 'title_size', TITLE_SIZE_OPTIONS, TITLE_SIZES, 'md',
            'title_px', 200, block, '右边可以直接填像素，留空就用左边的档位。');

        if (block.type !== 'text') {
            html += field(block.type === 'table' ? '表格内容位置' : '内容位置',
                `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="value_align">${selectOptions(ALIGN_OPTIONS, allow(block.value_align, ALIGNS, 'left'))}</select>`,
                block.type === 'metric' ? '数字默认靠左，一排数字块建议都改成「居中」，看着更整齐。' : '');
        }
        if (block.type === 'metric') {
            html += sizeField('数字字号', index, 'value_size', VALUE_SIZE_OPTIONS, VALUE_SIZES, 'xl',
                'value_px', 400, block, '挂大屏、离得远就选「超大」「巨大」，或直接在右边填像素。');
        }
        if (block.type === 'table') {
            html += sizeField('表头字号', index, 'header_size', TABLE_SIZE_OPTIONS, TABLE_SIZES, 'md',
                'header_px', 200, block, '就是最上面那行列名的大小。挂大屏选「超大」，或直接在右边填像素。');
            html += sizeField('表格文字字号', index, 'cell_size', TABLE_SIZE_OPTIONS, TABLE_SIZES, 'md',
                'cell_px', 200, block, '列多的时候选「很小」能塞下更多列。');
        }
        return html;
    }

    /** 动态变量的口径说明：告诉用户留空时系统每天会自动算成什么。 */
    const DATE_RANGE_HINTS = {
        today: '今天',
        yesterday: '昨天',
        last_n_days: n => `最近 ${n} 天的第一天`,
        last_n_to_yesterday: n => `${n} 天前到昨天的起始日`,
        last_n_to_today: n => `${n} 天前到今天的起始日`,
    };
    const PERIOD_HINTS = {
        current_month: '本月', last_month: '上个月', current_year: '本年', last_year: '去年',
    };

    /** 变量留空时的自动口径文案；返回空串表示这个变量没有动态规则。 */
    function autoRuleText(variable) {
        if (variable.type === 'period') return PERIOD_HINTS[variable.period_type] || '';
        const hint = DATE_RANGE_HINTS[variable.date_range_type];
        if (!hint) return '';
        return typeof hint === 'function' ? hint(clampInt(variable.last_n_days, 7, 1, 365)) : hint;
    }

    /**
     * 区块的变量面板。
     *
     * 脚本里的 #{变量} 在看板上没人来填，所以必须在配置时就交代清楚：
     * 留空＝每次刷新按脚本自己的动态规则重算（日期会跟着今天滚动），
     * 填了值＝这个看板永远用这个值。后者是常见误用，所以填了就立刻显红字警示。
     */
    function paramsSection(block, index) {
        if (block.type === 'text' || block.type === 'section' || block.type === 'clock' || !block.script_id) return '';
        const script = scriptCatalog.find(item => item.id === block.script_id);
        const variables = (script && script.variables) || [];
        if (!variables.length) return '';
        const params = block.params || {};
        const rows = variables.map(variable => {
            const name = variable.name || '';
            if (!name) return '';
            const value = params[name] == null ? '' : String(params[name]);
            const auto = autoRuleText(variable);
            const inputType = variable.type === 'date' ? 'date' : (variable.type === 'number' ? 'number' : 'text');
            const placeholder = auto ? `留空＝自动取${auto}` : (variable.default_value ? `留空＝用默认值 ${variable.default_value}` : '留空＝不传值');
            return `<div class="dash-param-row">
                <div class="dash-param-head">
                    <span class="dash-param-name">#{${escapeHtml(name)}}</span>
                    ${auto ? `<span class="dash-param-auto"><i class="fa fa-refresh mr-1"></i>动态：${escapeHtml(auto)}</span>` : ''}
                </div>
                <input type="${inputType}" class="${INPUT_CLASS}" ${INPUT_STYLE}
                    data-block-index="${index}" data-param-name="${escapeHtml(name)}"
                    value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
                ${value && auto ? '<p class="dash-param-warn"><i class="fa fa-lock mr-1"></i>已固定，看板不会再跟着日期滚动，想每天自动更新请清空</p>' : ''}
            </div>`;
        }).join('');
        return `<details class="dash-param-box" data-param-box="${index}"${block._paramsOpen ? ' open' : ''}>
            <summary><i class="fa fa-sliders mr-1"></i>脚本变量（${variables.length} 个）<span class="dash-param-sum">留空即按脚本规则自动取值</span></summary>
            <div class="dash-param-grid">${rows}</div>
        </details>`;
    }

    function columnWidthEditor(block, columns, index) {
        const displayed = block.columns && block.columns.length
            ? block.columns.filter(name => columns.includes(name)) : columns;
        const widths = block.column_widths && typeof block.column_widths === 'object' ? block.column_widths : {};
        const rows = displayed.map(name => {
            const width = clampInt(widths[name], 0, 60, 1200);
            return `<label class="dash-column-width-row">
                <span title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <input type="number" min="60" max="1200" step="10" class="${INPUT_CLASS}" ${INPUT_STYLE}
                    data-block-index="${index}" data-column-width="${escapeHtml(name)}"
                    value="${width || ''}" placeholder="自动">
                <em>px</em>
            </label>`;
        }).join('');
        return `<div class="dash-column-widths">${rows}</div>`;
    }

    function blockEditorCard(block, index) {
        const type = BLOCK_TYPES.find(item => item.value === block.type) || BLOCK_TYPES[0];
        const preview = block.script_id ? previewCache.get(previewKey(block)) : null;
        const columns = preview && !preview.error ? (preview.columns || []) : [];
        const total = editorState.blocks.length;
        // 表格块没有大号数字也没有图表色，只留标题色，免得给出无效选项。
        const colorFields = COLOR_FIELDS.filter(config => {
            if (config.key === 'accent_color') return block.type === 'bar' || block.type === 'progress' || block.type === 'metric';
            if (config.key === 'value_color') return block.type !== 'table';
            // 表头色和数据色只对表格有意义：表格没有"大号数字"，value_color 在这里
            // 被过滤掉了，所以数据文字必须有自己的 cell_color，否则表格一格颜色都调不了。
            if (config.key === 'header_color' || config.key === 'cell_color') return block.type === 'table';
            return true;
        });

        let dataSection = '';
        const noScriptType = block.type === 'text' || block.type === 'section' || block.type === 'clock';
        if (!noScriptType) {
            dataSection += field('数据来源：选一个自定义SQL脚本',
                `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="script_id">${scriptSelectOptions(block.script_id)}</select>`,
                '只能选你有权限执行的脚本。想加新查询请先去「自定义SQL」里保存一个。');

            if (!block.script_id) {
                dataSection += `<div class="dash-preview-note"><i class="fa fa-hand-o-up"></i><span>先选好脚本，系统会试跑一次并把返回的列名列出来，你再挑要展示哪一列。</span></div>`;
            } else if (!preview) {
                dataSection += `<div class="dash-preview-note"><i class="fa fa-spinner fa-spin"></i><span>正在试跑脚本，读取返回的列…</span></div>`;
            } else if (preview.error) {
                dataSection += `<div class="dash-preview-note is-error"><i class="fa fa-exclamation-triangle"></i><span>脚本试跑失败：${escapeHtml(preview.error)}。请先去「自定义SQL」里确认这个脚本能正常执行。</span></div>`;
            } else {
                dataSection += `<div class="dash-preview-note"><i class="fa fa-check-circle"></i><span>试跑成功，返回 ${columns.length} 列 / ${preview.total || 0} 行：${escapeHtml(columns.slice(0, 8).join('、'))}${columns.length > 8 ? ' …' : ''}</span></div>`;
            }
        }

        let mapping = '';
        if (block.type === 'text' || block.type === 'section') {
            mapping = field(block.type === 'section' ? '分区标题 / 说明' : '要显示的文字',
                `<textarea class="${INPUT_CLASS}" ${INPUT_STYLE} rows="3" data-block-index="${index}" data-field="body" placeholder="例如：以下数据统计口径为「已审核报工单」，每日 08:00 后为准。">${escapeHtml(block.body || '')}</textarea>`,
                '用来给看板分区、写统计口径或注意事项，不查数据库。');
        } else if (block.type === 'clock') {
            mapping = field('时钟显示内容', `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="clock_format">${selectOptions([
                { value: 'datetime', label: '日期 + 时间' }, { value: 'time', label: '只显示时间' }, { value: 'date', label: '只显示日期' }
            ], block.clock_format || 'datetime')}</select>`, '时钟由浏览器本地时间驱动，不执行 SQL。');
        } else if (columns.length) {
            if (['metric', 'gauge', 'status', 'comparison'].includes(block.type)) {
                mapping += field('怎么算出这个数字',
                    `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="aggregate">${selectOptions(AGGREGATES, block.aggregate || 'first')}</select>`,
                    '脚本只返回一行时选「取第一行的值」；返回多行想看总数选「统计行数」。');
                if (block.aggregate !== 'count') {
                    mapping += field('数字取哪一列',
                        `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="value_column">${selectOptions(columns, block.value_column)}</select>`,
                        '选一个数值列，比如「数量」「金额」。');
                }
                if (block.type === 'gauge') {
                    mapping += field('仪表下限', `<input type="number" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="min_value" value="${escapeHtml(block.min_value == null ? '0' : block.min_value)}">`, '仪表刻度起点。');
                    mapping += field('仪表上限', `<input type="number" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="max_value" value="${escapeHtml(block.max_value == null ? '100' : block.max_value)}">`, '仪表刻度终点。');
                    mapping += field('目标值（选填）', `<input type="number" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="target_value" value="${escapeHtml(block.target_value || '')}">`, '用于标记业务目标。');
                }
                if (block.type === 'status') {
                    mapping += field('状态取哪一列', `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="status_column">${selectOptions(columns, block.status_column || block.value_column)}</select>`, '正常/成功显示绿色，告警显示橙色，异常/失败显示红色。');
                }
                mapping += field('单位（选填）',
                    `<input type="text" maxlength="10" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="unit" value="${escapeHtml(block.unit || '')}" placeholder="条 / 台 / %">`,
                    '显示在数字后面，比如「条」「%」。');
                mapping += field('对比列（选填）',
                    `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="compare_column"><option value="">不做对比</option>${selectOptions(columns, block.compare_column)}</select>`,
                    '若脚本同时返回了「上期值」，选中后会显示涨跌百分比。');
                if (block.compare_column) {
                    mapping += field('涨了算好还是算坏',
                        `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="trend">${selectOptions([
                            { value: 'up_good', label: '涨了是好事（产量、完成数）' },
                            { value: 'up_bad', label: '涨了是坏事（异常数、超时数）' },
                            { value: 'none', label: '不判断好坏' }
                        ], block.trend || 'up_good')}</select>`,
                        '决定涨跌箭头显示绿色还是红色。');
                }
            } else if (block.type === 'table') {
                mapping += field('要展示的列（不选=全部）',
                    `<select class="${INPUT_CLASS}" ${INPUT_STYLE} multiple size="5" data-block-index="${index}" data-field="columns">${selectOptions(columns, null).replace(/ selected/g, '')}</select>`,
                    '按住 Ctrl（Mac 用 Command）可多选，顺序就是表格里的列顺序。');
                mapping += field('每列宽度（选填）', columnWidthEditor(block, columns, index),
                    '单位为 px，支持 60-1200；留空就是自动宽度。内容较多时表格可左右滚动。');
                const mode = allow(block.table_mode, TABLE_MODES, 'paged');
                mapping += field('行数多的时候怎么显示',
                    `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="table_mode">${selectOptions(TABLE_MODE_OPTIONS, mode)}</select>`,
                    MODE_HINTS[mode]);
                mapping += field(mode === 'paged' ? '显示前多少行' : '区块高度按多少行算',
                    `<input type="number" min="1" max="200" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="page_size" value="${escapeHtml(block.page_size || 20)}">`,
                    mode === 'paged'
                        ? '看板是概览，建议 10-30 行；要看全量请去「自定义SQL」导出。'
                        : (mode === 'lazy' ? '既是区块高度，也是每次往下追加的行数。' : '控制这一块显示多高，超出的行靠滚动看。'));
                if (mode === 'marquee') {
                    mapping += field('滚动速度',
                        `<input type="number" min="4" max="400" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="marquee_speed" value="${escapeHtml(block.marquee_speed || 30)}">`,
                        '每秒往上滚多少像素。30 大概是"能看清"的速度，鼠标放上去会暂停。');
                }
                mapping += field('按哪一列排序（选填）',
                    `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="sort_column"><option value="">保持SQL原有顺序</option>${selectOptions(columns, block.sort && block.sort.column)}</select>`, '');
                if (block.sort && block.sort.column) {
                    mapping += field('排序方向',
                        `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="sort_direction">${selectOptions([
                            { value: 'desc', label: '从大到小 / 从新到旧' }, { value: 'asc', label: '从小到大 / 从旧到新' }
                        ], block.sort.direction || 'desc')}</select>`, '');
                }
            } else {
                const labelHint = block.type === 'pie' ? '每个扇形代表哪一类，比如「车间名称」。' : '横轴的分类，比如「日期」「车间名称」。';
                mapping += field(block.type === 'pie' ? '分类取哪一列' : '横轴 / 名称取哪一列',
                    `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="label_column">${selectOptions(columns, block.label_column)}</select>`, labelHint);
                const multi = ['line', 'area', 'bar', 'grouped_bar', 'stacked_bar', 'metric_group'].includes(block.type);
                if (multi) {
                    mapping += field('数值列（可多选）',
                        `<select class="${INPUT_CLASS}" ${INPUT_STYLE} multiple size="5" data-block-index="${index}" data-field="value_columns">${selectOptions(columns, null).replace(/ selected/g, '')}</select>`,
                        '按住 Ctrl（Mac 用 Command）选择多个系列，最多 8 个。');
                } else {
                    mapping += field(block.type === 'progress' ? '进度按哪一列算' : '数值取哪一列',
                        `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="value_column">${selectOptions(columns, block.value_column || (block.value_columns || [])[0])}</select>`,
                        '必须是数值列。文本列画不出图。');
                }
                if (block.type === 'progress') {
                    mapping += field('100% 对应的目标值',
                        `<input type="number" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="target_value" value="${escapeHtml(block.target_value == null ? '100' : block.target_value)}">`,
                        '比如目标产量是 1000，就填 1000。');
                }
                if (block.type === 'pie') {
                    mapping += field('占比图样式', `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="pie_style">${selectOptions(PIE_STYLES, block.pie_style || 'donut')}</select>`, '标准、环形、玫瑰、半环四种样式。');
                    mapping += field('显示选项', `<label class="dash-check"><input type="checkbox" data-block-index="${index}" data-field="show_labels"${block.show_labels === false ? '' : ' checked'}> 标签</label><label class="dash-check"><input type="checkbox" data-block-index="${index}" data-field="show_legend"${block.show_legend === false ? '' : ' checked'}> 图例</label>`, '可按大屏空间自由取舍。');
                }
                if (['ranking', 'alert_list', 'timeline'].includes(block.type)) {
                    mapping += field('详情列（选填）', `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="detail_column"><option value="">不显示详情</option>${selectOptions(columns, block.detail_column)}</select>`, '展示补充说明或事件内容。');
                    mapping += field('状态列（选填）', `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="status_column"><option value="">不显示状态</option>${selectOptions(columns, block.status_column)}</select>`, '正常/告警/严重会自动配色。');
                }
                if (['alert_list', 'timeline'].includes(block.type)) {
                    const listMode = allow(block.list_mode, ['static', 'marquee'], 'static');
                    mapping += field('动态列表播放方式', `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="list_mode">${selectOptions([
                        { value: 'static', label: '静态展示' }, { value: 'marquee', label: '自动匀速滚动' }
                    ], listMode)}</select>`, '数据较多时可循环滚动，鼠标悬停会暂停。');
                    if (listMode === 'marquee') {
                        mapping += field('滚动速度', `<input type="number" min="4" max="400" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="marquee_speed" value="${escapeHtml(block.marquee_speed || 24)}">`, '每秒滚动的像素数，推荐 20-35。');
                    }
                }
            }
        } else if (block.script_id && preview && !preview.error) {
            mapping = `<div class="dash-preview-note is-error"><i class="fa fa-exclamation-triangle"></i><span>这个脚本没有返回任何列，换一个脚本试试。</span></div>`;
        }

        return `<div class="dash-block-editor" data-editor-index="${index}">
            <div class="dash-block-editor-head">
                <span class="dash-block-editor-no">${index + 1}</span>
                <span class="dash-block-editor-name">${escapeHtml(block.title || '未命名内容块')} · ${escapeHtml(type.label)}</span>
                <span class="dash-block-editor-pos">第 ${index + 1} / ${total} 块</span>
                <div class="dash-block-editor-tools">
                    <button type="button" data-step-block="-1" title="配置上一块"${index === 0 ? ' disabled' : ''}><i class="fa fa-chevron-left"></i></button>
                    <button type="button" data-step-block="1" title="配置下一块"${index === total - 1 ? ' disabled' : ''}><i class="fa fa-chevron-right"></i></button>
                    <button type="button" data-move-block="${index}" data-move-dir="-1" title="在布局里往前挪"${index === 0 ? ' disabled' : ''}><i class="fa fa-arrow-left"></i></button>
                    <button type="button" data-move-block="${index}" data-move-dir="1" title="在布局里往后挪"${index === total - 1 ? ' disabled' : ''}><i class="fa fa-arrow-right"></i></button>
                    <button type="button" class="is-danger" data-remove-block="${index}" title="删除这一块"><i class="fa fa-trash-o"></i></button>
                </div>
            </div>
            <div class="mb-3">
                <label class="block text-xs font-medium text-gray-700 mb-1.5">这一块用什么方式展示</label>
                <div class="dash-type-picker">${typePicker(block, index)}</div>
                <p class="dash-hint">${escapeHtml(type.hint)}</p>
            </div>
            <div class="dash-field-grid">
                ${field('这一块的标题', `<input type="text" maxlength="40" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="title" value="${escapeHtml(block.title || '')}" placeholder="例如：今日报工数量">`, '显示在这一块的左上角。')}
                ${field('补充说明（选填）', `<input type="text" maxlength="80" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="description" value="${escapeHtml(block.description || '')}" placeholder="例如：统计口径为已审核单据">`, '写在标题下面的小字。')}
                ${dataSection}
                ${paramsSection(block, index)}
                ${mapping}
                ${field('这一块占多宽', `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="width">${widthOptions((block.layout && block.layout.w) || 6)}</select>`, '一行总共 12 格，可精确选择 1-12 格。也可拖布局条右边缘。')}
                ${field('这一块高度（像素）', `<input type="number" min="120" max="1600" step="10" class="${INPUT_CLASS}" ${INPUT_STYLE} data-block-index="${index}" data-field="height_px" value="${escapeHtml((block.layout && block.layout.height_px) || Math.max(120, ((block.layout && block.layout.h) || 2) * 92))}">`, '支持 120-1600px。旧看板的高度档位会自动换算。')}
            </div>
            <details class="dash-color-box" data-style-box="${index}"${block._styleOpen ? ' open' : ''}>
                <summary class="dash-color-summary">
                    <i class="fa fa-magic mr-1.5"></i>外观：底色、文字位置、${block.type === 'table' ? '表头/数据字号' : '字号'}（选填）
                    <span class="dash-color-summary-note">不改就跟着看板主题走</span>
                </summary>
                <div class="dash-field-grid">${styleFields(block, index)}</div>
            </details>
            <details class="dash-color-box" data-color-box="${index}"${block._colorOpen || colorFields.some(c => safeColor(block[c.key])) ? ' open' : ''}>
                <summary class="dash-color-summary">
                    <i class="fa fa-paint-brush mr-1.5"></i>配色：${block.type === 'table' ? '标题、表头、数据文字' : '标题、数字'}（选填）
                    <span class="dash-color-summary-note">不选就跟着看板主题走</span>
                </summary>
                <div class="dash-color-grid">${colorFields.map(config => colorPicker(block, index, config)).join('')}</div>
            </details>
        </div>`;
    }

    /**
     * 布局条：用真实的 12 栏网格画出看板排布缩略图。
     *
     * 做成缩略图而不是让整张卡片互拖：卡片很高，拖起来要滚屏，
     * 缩略图一屏就能看完全部排布，拖起来所见即所得。
     */
    function renderLayoutStrip() {
        const box = el('dashboardLayoutBox');
        const strip = el('dashboardLayoutStrip');
        if (!box || !strip || !editorState) return;
        // 一块也要显示：现在点方块就是"选中它去右边配置"，不只是排顺序。
        if (!editorState.blocks.length) { box.classList.add('hidden'); strip.innerHTML = ''; return; }
        box.classList.remove('hidden');
        const active = activeBlockIndex();
        strip.innerHTML = editorState.blocks.map((block, index) => {
            const type = BLOCK_TYPES.find(item => item.value === block.type) || BLOCK_TYPES[0];
            const width = Math.max(1, Math.min(GRID_COLUMNS, (block.layout && block.layout.w) || 6));
            const heightPx = clampInt(block.layout && block.layout.height_px,
                Math.max(120, ((block.layout && block.layout.h) || 2) * 92), 120, 1600);
            const accent = safeColor(block.accent_color) || safeColor(block.value_color);
            return `<div class="dash-layout-cell${index === active ? ' is-active' : ''}" data-layout-index="${index}"
                style="grid-column:span ${width};min-height:${Math.max(42, Math.round(heightPx / 7))}px;${accent ? `--cell-accent:${accent};` : ''}"
                title="${escapeHtml(block.title || '未命名')}（${escapeHtml(type.label)}）｜宽 ${width}/12">
                <span class="dash-layout-grip" data-layout-grip="${index}" title="按住拖动换位置"><i class="fa fa-arrows"></i></span>
                <span class="dash-layout-cell-name"><i class="fa ${type.icon} mr-1"></i>${escapeHtml(block.title || `第 ${index + 1} 块`)}</span>
                <span class="dash-layout-cell-meta">宽 ${width}/12</span>
                <span class="dash-layout-resize" data-layout-resize="${index}" title="左右拖动改宽度"></span>
            </div>`;
        }).join('');
    }

    /**
     * 效果预览：用看板页同一套 blockShell / renderBlockBody 画一遍。
     *
     * 不另写一套简化渲染：另写一套就会和真看板长得不一样，预览也就失去意义。
     * 数据用 /preview 已经取回的样例行（最多 20 行），所以表格的分页、滚动、
     * 跑马灯差别都能看出来，只是行数比线上少。
     */
    /** 预览里那行看板名称。字号档由调用方拼在舞台 class 上，这里只管文字、颜色、位置。
     *  名字用 textContent 落，不拼 HTML——它是用户输入的，拼进 innerHTML 就是注入口子。 */
    function renderPreviewName(stage) {
        const title = el('dashboardPreviewTitle');
        const headline = el('dashboardPreviewHeadline');
        if (!title || !headline || !editorState) return;
        // 边打字边看效果，所以读输入框而不是 editorState.name（后者只在保存时才同步）。
        const input = el('dashboardNameInput');
        title.textContent = (input && input.value.trim()) || editorState.name || '未命名看板';
        const desc = el('dashboardPreviewDesc');
        const descInput = el('dashboardDescInput');
        if (desc) {
            desc.textContent = (descInput && descInput.value.trim()) || editorState.description || '';
            desc.classList.toggle('hidden', !desc.textContent);
        }
        const align = allow(editorState.name_align, ALIGNS, 'left');
        headline.className = `min-w-0 dash-stage-headline${align === 'left' ? '' : ` is-name-${align}`}`;
        const color = safeColor(editorState.name_color);
        const px = clampInt(editorState.name_px, 0, 0, 200);
        // 没配就把变量删掉，让 CSS 里的默认值/主题规则接管；留个空串会算成非法值。
        if (color) stage.style.setProperty('--stage-name-color', color);
        else stage.style.removeProperty('--stage-name-color');
        if (px) stage.style.setProperty('--stage-name-px', `${px}px`);
        else stage.style.removeProperty('--stage-name-px');
    }

    function applyPreviewSize() {
        const canvas = el('dashboardPreviewCanvas');
        const frame = el('dashboardPreviewFrame');
        const select = el('dashboardPreviewSize');
        if (!canvas || !frame || !select) return;
        const preset = PREVIEW_SIZES[select.value] || PREVIEW_SIZES.auto;
        if (!preset.width) {
            canvas.classList.remove('is-fixed');
            canvas.style.width = '100%'; canvas.style.height = 'auto'; canvas.style.transform = '';
            frame.style.setProperty('--preview-scaled-height', 'auto');
            return;
        }
        canvas.classList.add('is-fixed');
        const available = Math.max(320, frame.clientWidth - 20);
        const scale = Math.min(1, available / preset.width);
        canvas.style.width = `${preset.width}px`; canvas.style.height = `${preset.height}px`;
        canvas.style.transform = `scale(${scale})`;
        frame.style.setProperty('--preview-scaled-height', `${Math.round(preset.height * scale)}px`);
    }

    function togglePreviewWide() {
        const modal = el('dashboardEditorModal');
        if (!modal) return;
        modal.classList.toggle('is-preview-wide');
        requestAnimationFrame(applyPreviewSize);
    }

    function togglePreviewZoom() {
        const box = el('dashboardPreviewBox');
        if (!box) return;
        if (document.fullscreenElement) document.exitFullscreen(); else box.requestFullscreen?.();
    }

    function renderVisualPreview() {
        const box = el('dashboardPreviewBox');
        const stage = el('dashboardPreviewStage');
        const grid = el('dashboardPreviewGrid');
        if (!box || !stage || !grid || !editorState) return;
        if (!editorState.blocks.length) { box.classList.add('hidden'); grid.innerHTML = ''; return; }
        box.classList.remove('hidden');

        // 主题类名必须过白名单：拼进 class 的值不能直接来自状态。
        const theme = allow(editorState.theme, THEMES.map(item => item.value), 'aurora');
        // 名称字号档也拼进舞台的 class：CSS 变量挂在 .dash-stage 上，靠继承传给标题。
        // md 是默认档，不加类——加了就会把窄屏那条 21px 规则顶掉（和看板页保持一致）。
        const nameSize = allow(editorState.name_size, NAME_SIZES, 'md');
        stage.className = `dash-stage dash-vp-stage dash-theme-${theme}${LIGHT_THEMES.indexOf(theme) >= 0 ? ' is-light' : ''}${nameSize === 'md' ? '' : ` is-name-${nameSize}`}`;
        renderPreviewName(stage);

        const photo = el('dashboardPreviewPhoto');
        const video = el('dashboardPreviewVideo');
        const veil = el('dashboardPreviewVeil');
        const assetId = /^[0-9a-f]{32}$/.test(String(editorState.bg_image || '')) ? editorState.bg_image : '';
        if (photo && veil) {
            const fit = allow(editorState.bg_fit, BG_FITS, 'cover');
            const url = assetId ? `/api/custom_dashboards/assets/${assetId}/raw` : '';
            // 视频背景要渲染成 <video>，图片走 CSS background-image，两条路只能亮一条。
            const wantVideo = !!assetId && isVideoAsset(assetId);
            if (assetId) {
                // id 先过 32 位十六进制正则再拼进 url()，和后端 _asset_id 一个口径。
                stage.style.setProperty('--dash-bg-blur', `${clampInt(editorState.bg_blur, 0, 0, 20)}px`);
                stage.style.setProperty('--dash-dim', String(clampInt(editorState.bg_dim, 35, 0, 90) / 100));
                veil.classList.remove('hidden');
            } else {
                veil.classList.add('hidden');
            }
            if (wantVideo) {
                stage.style.removeProperty('--dash-bg-image');
                photo.className = 'dash-stage-photo hidden';
            } else {
                if (url) stage.style.setProperty('--dash-bg-image', `url('${url}')`);
                else stage.style.removeProperty('--dash-bg-image');
                photo.className = assetId
                    ? `dash-stage-photo${fit === 'contain' ? ' is-contain' : (fit === 'tile' ? ' is-tile' : '')}`
                    : 'dash-stage-photo hidden';
            }
            if (video) {
                if (wantVideo) {
                    // 只在地址真的变了时才重设 src：每次预览重画都赋一遍会让视频从头开始跳一下。
                    if (video.getAttribute('src') !== url) video.setAttribute('src', url);
                    video.className = `dash-stage-video${fit === 'contain' ? ' is-contain' : ''}`;
                    const play = video.play();
                    if (play && play.catch) play.catch(() => {});
                } else {
                    video.removeAttribute('src');
                    video.className = 'dash-stage-video hidden';
                }
            }
        }

        grid.innerHTML = editorState.blocks.map(block => {
            if (block.type === 'text' || block.type === 'section' || block.type === 'clock') return blockShell(block, null);
            if (!block.script_id) {
                return blockShell(block, { success: false, error: '还没选脚本，选完就能在这里看到真实数据' });
            }
            const preview = previewCache.get(previewKey(block));
            if (!preview) return blockShell(block, null);
            if (preview.error) return blockShell(block, { success: false, error: preview.error });
            return blockShell(block, {
                success: true,
                result: { columns: preview.columns || [], rows: preview.rows || [], total: preview.total || 0, truncated: false },
            });
        }).join('');
        // innerHTML 重画会丢监听，滚动加载模式的表格要重新绑一次。
        bindTableScroll(grid); bindMarquee(grid); bindClocks(grid);
        requestAnimationFrame(applyPreviewSize);
    }

    /** 把 activeIndex 夹回合法范围；没有块时返回 -1。 */
    function activeBlockIndex() {
        if (!editorState || !editorState.blocks.length) return -1;
        const index = Number(editorState.activeIndex);
        if (!Number.isInteger(index) || index < 0 || index >= editorState.blocks.length) return 0;
        return index;
    }

    /**
     * 右侧配置区：一次只画"正在配置的那一块"。
     *
     * 原来把所有块的表单竖着堆一列，块一多就得反复上下找，每块还只有半幅宽度。
     * 改成一次一块之后表单能用整幅宽度，选哪块由左边的布局条决定。
     */
    function renderEditorBlocks() {
        const container = el('dashboardBlockList');
        if (!container || !editorState) return;
        renderLayoutStrip();
        renderVisualPreview();
        if (!editorState.blocks.length) {
            container.innerHTML = '<p class="dash-build-empty">还没有内容块，点左边的按钮先摆上去。</p>';
            return;
        }
        const index = activeBlockIndex();
        editorState.activeIndex = index;
        container.innerHTML = blockEditorCard(editorState.blocks[index], index);
        // 多选列表要在 DOM 就位后回填选中项。
        const block = editorState.blocks[index];
        if (block.type === 'table' && block.columns && block.columns.length) {
            const select = container.querySelector(`select[data-block-index="${index}"][data-field="columns"]`);
            if (select) Array.from(select.options).forEach(option => { option.selected = block.columns.includes(option.value); });
        }
        const valuesSelect = container.querySelector(`select[data-block-index="${index}"][data-field="value_columns"]`);
        if (valuesSelect) {
            const selected = Array.isArray(block.value_columns) ? block.value_columns : [];
            Array.from(valuesSelect.options).forEach(option => { option.selected = selected.includes(option.value); });
        }
    }

    /** 试跑脚本拿列名，并按列类型给区块填一套能直接出图的默认值。 */
    async function ensurePreview(scriptId, blockIndex) {
        if (!scriptId) return;
        const target = editorState && editorState.blocks[blockIndex];
        if (!target || target.script_id !== scriptId) return;
        const blockId = target.id;
        const requestId = (previewRequests.get(blockId) || 0) + 1;
        previewRequests.set(blockId, requestId);
        const params = target.params || {};
        const key = previewKey(target);
        if (!previewCache.has(key)) {
            try {
                const response = await fetch('/api/custom_dashboards/preview', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    // dashboard_id 用于逐看板管理权限鉴权；新建时为空，走「可新建」判断。
                    body: JSON.stringify({ script_id: scriptId, params, dashboard_id: (editorState && editorState.id) || '' })
                });
                const data = await response.json();
                previewCache.set(key, data.success
                    ? { columns: data.columns || [], rows: data.rows || [], total: data.total || 0 }
                    : { error: data.error || '脚本执行失败' });
            } catch (error) {
                previewCache.set(key, { error: error.message || String(error) });
            }
        }
        // 编辑器已关闭、区块已删除/换脚本、或有更新请求时，丢弃这个异步结果。
        const block = editorState && editorState.blocks.find(item => item.id === blockId);
        if (!block || block.script_id !== scriptId || previewRequests.get(blockId) !== requestId) return;
        const preview = previewCache.get(key);
        if (preview && !preview.error) {
            const guess = guessColumns(preview.columns, preview.rows);
            if (!Array.isArray(block.value_columns) || !block.value_columns.length) {
                block.value_columns = [guess.numeric[0] || preview.columns[0] || ''].filter(Boolean);
            }
            if (!block.value_column) block.value_column = block.value_columns[0] || '';
            if (!block.label_column) block.label_column = guess.textual[0] || preview.columns[0] || '';
        }
        renderEditorBlocks();
    }

    /** 各展示方式的默认尺寸：切换类型和新建时都用这一份，避免两处各写一遍。 */
    function defaultLayoutFor(type) {
        if (type === 'metric' || type === 'status') return { w: 3, h: 2, height_px: 160 };
        if (type === 'gauge' || type === 'comparison') return { w: 4, h: 3, height_px: 280 };
        if (type === 'table' || type === 'alert_list' || type === 'timeline') return { w: 12, h: 4, height_px: 420 };
        if (type === 'text' || type === 'section' || type === 'clock') return { w: 12, h: 2, height_px: 140 };
        return { w: 6, h: 3, height_px: 300 };
    }

    /**
     * 添加一块。
     *
     * 追加到末尾而不是插到最前：先摆布局的用法下，从左往右一块块往后摆才顺手。
     * 新块只定类型和尺寸，不要求马上填内容——摆完整体排布再回头逐块配置。
     */
    function addBlock(type) {
        if (editorState.blocks.length >= MAX_BLOCKS) { toast(`一个看板最多 ${MAX_BLOCKS} 块`, 'warning'); return; }
        const blockType = allow(type, BLOCK_TYPES.map(item => item.value), 'metric');
        editorState.blocks.push({
            id: newBlockId(), type: blockType, title: '', description: '', script_id: '',
            aggregate: 'first', value_column: '', value_columns: [], label_column: '', columns: [], column_widths: {}, page_size: 20,
            sort: {}, trend: 'up_good', pie_style: 'donut', show_labels: true, show_legend: true,
            target_value: blockType === 'progress' ? '100' : '', list_mode: 'static', marquee_speed: 24,
            layout: defaultLayoutFor(blockType)
        });
        // 新块直接成为"正在配置的那一块"，右边立刻显示它的表单。
        editorState.activeIndex = editorState.blocks.length - 1;
        renderEditorBlocks();
        const list = el('dashboardBlockList');
        const titleInput = list && list.querySelector(`[data-block-index="${editorState.activeIndex}"][data-field="title"]`);
        if (titleInput) titleInput.focus();
    }

    /** 「添加一块」按钮组：按展示方式直接摆，省掉"先加一块再改类型"这一步。 */
    function renderAddTypes() {
        const box = el('dashboardAddTypes');
        if (!box) return;
        box.innerHTML = BLOCK_TYPES.map(type => `
            <button type="button" class="dash-add-type" data-add-type="${type.value}" title="${escapeHtml(type.hint)}">
                <i class="fa ${type.icon}"></i><span>${escapeHtml(type.label)}</span>
            </button>`).join('');
    }

    /** 背景主题选择器：直接拿主题色画出小样，选哪个一眼能看出来。按深浅分三组。
     *
     * 每组 20+ 套，所以只画色块不写名字——带名字的胶囊一行只放得下四五个，
     * 三组铺开就把整个编辑器挤满了。名字挪到 title 悬浮提示，外加组标题上
     * 实时显示当前选中的那套，不至于「选了不知道选的是哪个」。
     */
    function renderThemePicker() {
        const box = el('dashboardThemePicker');
        if (!box || !editorState) return;
        const current = editorState.theme || 'command_center';
        const currentTheme = THEMES.filter(theme => theme.value === current)[0];
        box.innerHTML = THEME_GROUPS.map(group => {
            const items = THEMES.filter(theme => theme.group === group);
            if (!items.length) return '';
            const options = items.map(theme => `
                <button type="button" class="dash-theme-opt dash-theme-${theme.value}${theme.value === current ? ' is-on' : ''}${theme.featured ? ' is-featured' : ''}"
                    data-theme-set="${theme.value}" title="${escapeHtml(theme.label)}" aria-label="${escapeHtml(theme.label)}">
                    <span class="dash-theme-swatch"></span><span class="dash-theme-name">${escapeHtml(theme.label)}</span>
                </button>`).join('');
            const picked = currentTheme && currentTheme.group === group
                ? `<em class="dash-theme-picked">${escapeHtml(currentTheme.label)}</em>` : '';
            return `<div class="dash-theme-group">
                <span class="dash-theme-group-name">${escapeHtml(group)}${group === '浅色' ? '（白天看不刺眼）' : ''}
                    <span class="dash-theme-count">${items.length} 套</span>${picked}</span>
                <div class="dash-theme-row">${options}</div>
            </div>`;
        }).join('');
    }

    // 视频类扩展名，和后端 assets.VIDEO_EXTS 一份口径。上传上限也按这个分流。
    const VIDEO_EXTS = ['mp4', 'webm'];
    const MAX_IMAGE_MB = 6;
    const MAX_VIDEO_MB = 30;

    /** 资源 id 是不是视频。查不到就当图片，渲染成 background-image 顶多是空白，不会报错。 */
    function isVideoAsset(assetId) {
        const asset = assetCatalog.find(item => item.id === assetId);
        return !!asset && VIDEO_EXTS.indexOf(asset.ext) >= 0;
    }

    /**
     * 背景选择器：已上传的图 / 视频 + 一个上传入口。
     *
     * 存的是资源 id 不是地址：让人填图片网址等于把看板打开时的请求发给第三方，
     * 也能拿来探内网，所以素材必须先上传到本机。
     */
    function renderBgPicker() {
        const box = el('dashboardBgPicker');
        if (!box || !editorState) return;
        const current = editorState.bg_image || '';
        const tiles = assetCatalog.map(asset => {
            const src = `/api/custom_dashboards/assets/${encodeURIComponent(asset.id)}/raw`;
            // 视频缩略图直接放一个静音循环的 <video>：没有截帧能力，用 <img> 会是个破图。
            const thumb = VIDEO_EXTS.indexOf(asset.ext) >= 0
                ? `<video src="${src}" muted loop autoplay playsinline preload="metadata" tabindex="-1"></video>
                   <span class="dash-bg-opt-tag">动态</span>`
                : `<img src="${src}" alt="${escapeHtml(asset.name)}" loading="lazy">`;
            return `
            <div class="dash-bg-opt${asset.id === current ? ' is-on' : ''}" data-bg-set="${escapeHtml(asset.id)}"
                 title="${escapeHtml(asset.name)}（${Math.round((asset.size || 0) / 1024)}KB）">
                ${thumb}
                <span class="dash-bg-opt-name">${escapeHtml(asset.name)}</span>
                <button type="button" class="dash-bg-del" data-bg-delete="${escapeHtml(asset.id)}" title="删除这个背景"><i class="fa fa-trash-o"></i></button>
            </div>`;
        }).join('');
        box.innerHTML = `
            <div class="dash-bg-grid">
                <div class="dash-bg-opt is-none${current ? '' : ' is-on'}" data-bg-set="" title="不用背景图">
                    <span class="dash-bg-none"><i class="fa fa-ban"></i>不用图</span>
                </div>
                ${tiles}
                <label class="dash-bg-opt is-upload" title="上传自己的背景图或背景视频">
                    <span class="dash-bg-none"><i class="fa fa-cloud-upload"></i>上传</span>
                    <input type="file" id="dashboardBgUpload" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm" class="hidden">
                </label>
            </div>
            <p class="dash-hint">静态图 PNG / JPG，动态背景可以用 MP4 / WEBM 视频（不超过 30MB）或动图 GIF / WEBP（不超过 6MB）。视频会自动静音循环播放。建议用横向的、内容别太花的素材，文字才看得清。</p>
            ${current ? `<div class="dash-field-grid mt-2">
                ${field('画面怎么铺', `<select class="${INPUT_CLASS}" ${INPUT_STYLE} data-dash-field="bg_fit">${selectOptions(BG_FIT_OPTIONS, allow(editorState.bg_fit, BG_FITS, 'cover'))}</select>`, '视频只支持铺满和完整显示，平铺按铺满处理。')}
                ${field('压暗程度', `<input type="number" min="0" max="85" class="${INPUT_CLASS}" ${INPUT_STYLE} data-dash-field="bg_dim" value="${escapeHtml(editorState.bg_dim === undefined ? 35 : editorState.bg_dim)}">`, '图太亮时文字看不清，调大一点压暗。0 是不压。')}
                ${field('模糊程度', `<input type="number" min="0" max="20" class="${INPUT_CLASS}" ${INPUT_STYLE} data-dash-field="bg_blur" value="${escapeHtml(editorState.bg_blur || 0)}">`, '让图当底纹用，不抢内容。单位是像素，0 是不模糊。')}
            </div>` : ''}`;
    }

    /** 拉取已上传的背景图列表。失败不阻断编辑器，只是选不到图。 */
    async function loadAssets() {
        try {
            const response = await fetch('/api/custom_dashboards/assets');
            const data = await response.json();
            assetCatalog = data.success ? (data.assets || []) : [];
        } catch (error) {
            assetCatalog = [];
        }
        renderBgPicker();
    }

    async function uploadBgImage(file) {
        if (!file) return;
        // 前端先挡一次大小：传上去再被拒，白等一次上传。视频的上限和图片不一样。
        // 这里用 MIME 只是为了挑上限，真正的类型判定在后端按文件头做（MIME 是浏览器说的，不可信）。
        const looksVideo = String(file.type || '').indexOf('video/') === 0;
        const limitMb = looksVideo ? MAX_VIDEO_MB : MAX_IMAGE_MB;
        if (file.size > limitMb * 1024 * 1024) {
            toast(`${looksVideo ? '视频' : '图片'}不能超过 ${limitMb}MB`, 'warning');
            return;
        }
        const form = new FormData();
        form.append('file', file);
        form.append('name', file.name || '背景图');
        toast(looksVideo ? '正在上传背景视频…' : '正在上传背景图…', 'info');
        try {
            const response = await fetch('/api/custom_dashboards/assets', { method: 'POST', body: form });
            const data = await response.json();
            if (!data.success) { toast(data.error || '上传失败', 'error'); return; }
            assetCatalog.unshift(data.asset);
            // 上传完直接选中：绝大多数情况上传就是为了用它。
            editorState.bg_image = data.asset.id;
            renderBgPicker();
            renderVisualPreview();
            toast('背景已上传并选用', 'success');
        } catch (error) {
            toast(`上传失败: ${error.message || error}`, 'error');
        }
    }

    async function deleteBgImage(assetId) {
        if (!window.confirm('删除这个背景素材？正在使用它的看板会变回纯色背景。')) return;
        try {
            const response = await fetch(`/api/custom_dashboards/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
            const data = await response.json();
            if (!data.success) { toast(data.error || '删除失败', 'error'); return; }
            assetCatalog = assetCatalog.filter(item => item.id !== assetId);
            if (editorState && editorState.bg_image === assetId) editorState.bg_image = '';
            renderBgPicker();
            toast('背景图已删除', 'success');
        } catch (error) {
            toast(`删除失败: ${error.message || error}`, 'error');
        }
    }

    /**
     * 勾了免登录后把地址显示出来，方便直接复制到大屏机器上。
     * 新建的看板还没有 id，就先说明保存后才有地址——空着会让人以为功能没生效。
     */
    function renderPublicUrl() {
        const box = el('dashboardPublicUrl');
        const input = el('dashboardPublicInput');
        if (!box || !input || !editorState) return;
        if (!input.checked) { box.classList.add('hidden'); box.textContent = ''; return; }
        box.classList.remove('hidden');
        box.textContent = editorState.id
            // dashboardUrl() 自己就带 origin，别再拼一次（拼了会成 http://a:59496http://a:59496/...）
            ? `免登录地址：${dashboardUrl(editorState.id)}`
            : '保存后这里会显示可直接打开的地址。';
    }

    /** 看板名称的颜色控件。没配颜色时「跟随主题」按钮点亮，色块摆一个当前主题下的近似色。
     *  <input type="color"> 没有"空值"这个状态，所以是否配色靠 editorState.name_color 判断，
     *  不能靠读控件——读控件永远能读到一个颜色，会把"没配"误当成"配了白色"。 */
    function renderNameColor() {
        if (!editorState) return;
        const chip = el('dashboardNameColorInput');
        const reset = el('dashboardNameColorClear');
        const picked = safeColor(editorState.name_color);
        if (chip) chip.value = picked || (LIGHT_THEMES.indexOf(editorState.theme) >= 0 ? '#1f2937' : '#ffffff');
        if (reset) reset.classList.toggle('is-on', !picked);
    }

    function openEditor(dashboard) {
        editorState = dashboard
            ? JSON.parse(JSON.stringify({
                id: dashboard.id, name: dashboard.name, description: dashboard.description,
                refresh_seconds: dashboard.refresh_seconds || 0, theme: dashboard.theme || 'aurora',
                bg_image: dashboard.bg_image || '', bg_fit: dashboard.bg_fit || 'cover',
                bg_dim: dashboard.bg_dim === undefined ? 35 : dashboard.bg_dim, bg_blur: dashboard.bg_blur || 0,
                name_size: dashboard.name_size || 'md', name_px: dashboard.name_px || 0,
                name_color: dashboard.name_color || '', name_align: dashboard.name_align || 'left',
                public: dashboard.public === true,
                blocks: dashboard.blocks || []
            }))
            : {
                id: null, name: '', description: '', refresh_seconds: 0, theme: 'command_center',
                bg_image: '', bg_fit: 'cover', bg_dim: 35, bg_blur: 0,
                name_size: 'md', name_px: 0, name_color: '', name_align: 'left',
                public: false, blocks: []
            };
        // 打开就从第一块开始配置（新建看板时还没有块，activeBlockIndex 会给 -1）。
        editorState.activeIndex = 0;

        el('dashboardEditorTitle').textContent = editorState.id ? '编辑看板' : '新建看板';
        el('dashboardNameInput').value = editorState.name || '';
        el('dashboardDescInput').value = editorState.description || '';
        el('dashboardRefreshInput').value = String(editorState.refresh_seconds || 0);
        // 看板名称的四个控件。下拉项在 JS 里生成，选项文案就不用在模板里抄一份了。
        const nameSize = el('dashboardNameSizeInput');
        if (nameSize) nameSize.innerHTML = selectOptions(NAME_SIZE_OPTIONS, allow(editorState.name_size, NAME_SIZES, 'md'));
        const nameAlign = el('dashboardNameAlignInput');
        if (nameAlign) nameAlign.innerHTML = selectOptions(ALIGN_OPTIONS, allow(editorState.name_align, ALIGNS, 'left'));
        const namePx = el('dashboardNamePxInput');
        // 0 显示成空：填了 0 和"没填"是一个意思，摆个 0 在框里反而像是设了个字号。
        if (namePx) namePx.value = editorState.name_px ? String(editorState.name_px) : '';
        renderNameColor();
        const publicInput = el('dashboardPublicInput');
        if (publicInput) publicInput.checked = editorState.public === true;
        renderPublicUrl();
        renderAddTypes();
        renderThemePicker();
        renderBgPicker();
        // 背景图列表每次打开编辑器都重取：别人可能刚上传了新图。
        loadAssets();
        el('dashboardEditorError').textContent = '';
        el('dashboardEditorModal').classList.remove('hidden');
        renderEditorBlocks();
        // 编辑已有看板时补齐各区块的列信息，否则下拉框是空的。
        editorState.blocks.forEach((block, index) => { if (block.script_id) ensurePreview(block.script_id, index); });
    }

    function closeEditor() {
        el('dashboardEditorModal').classList.add('hidden');
        editorState = null;
    }

    async function saveEditor() {
        if (!editorState) return;
        const errorLabel = el('dashboardEditorError');
        const name = el('dashboardNameInput').value.trim();
        if (!name) { errorLabel.textContent = '请先填写看板名称'; return; }
        if (!editorState.blocks.length) { errorLabel.textContent = '至少添加一个内容块'; return; }

        // 一次只显示一块，所以校验不过时要顺手把那一块切出来，
        // 否则提示写着"第 5 块"，用户眼前却是第 1 块的表单。
        const jumpTo = (i, message) => {
            errorLabel.textContent = message;
            if (editorState.activeIndex !== i) { editorState.activeIndex = i; renderEditorBlocks(); }
        };
        for (let i = 0; i < editorState.blocks.length; i += 1) {
            const block = editorState.blocks[i];
            const noValueTypes = ['table', 'status', 'alert_list', 'timeline'];
            if (block.type === 'text' || block.type === 'section') {
                if (!String(block.body || '').trim()) { jumpTo(i, `第 ${i + 1} 块是文字区块，请填写内容`); return; }
            } else if (block.type === 'clock') {
                continue;
            } else if (!block.script_id) {
                jumpTo(i, `第 ${i + 1} 块还没有选 SQL 脚本`); return;
            } else if (!noValueTypes.includes(block.type) && block.aggregate !== 'count'
                    && !block.value_column && !(block.value_columns || []).length) {
                jumpTo(i, `第 ${i + 1} 块还没有选数值列`); return;
            }
        }

        const payload = {
            name,
            description: el('dashboardDescInput').value.trim(),
            refresh_seconds: Number(el('dashboardRefreshInput').value) || 0,
            theme: editorState.theme || 'command_center',
            bg_image: editorState.bg_image || '',
            bg_fit: editorState.bg_fit || 'cover',
            bg_dim: editorState.bg_dim === undefined ? 35 : editorState.bg_dim,
            bg_blur: editorState.bg_blur || 0,
            // 看板名称的样式。后端还会再过一遍白名单，这里只是别把明显非法的值发出去。
            name_size: allow(editorState.name_size, NAME_SIZES, 'md'),
            name_px: clampInt(editorState.name_px, 0, 0, 200),
            name_color: editorState.name_color || '',
            name_align: allow(editorState.name_align, ALIGNS, 'left'),
            // 直接读勾选框而不是 editorState：这一项没有中间状态，读控件最不容易走样。
            public: !!(el('dashboardPublicInput') && el('dashboardPublicInput').checked),
            // _colorOpen 只是界面上的展开状态，不该存进配置。
            blocks: editorState.blocks.map(block => {
                const copy = Object.assign({}, block);
                delete copy._colorOpen;
                delete copy._styleOpen;
                delete copy._paramsOpen;
                return copy;
            })
        };
        const url = editorState.id ? `/api/custom_dashboards/${encodeURIComponent(editorState.id)}` : '/api/custom_dashboards';
        try {
            const response = await fetch(url, {
                method: editorState.id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (!data.success) { errorLabel.textContent = data.error || '保存失败'; return; }
            const savedId = data.dashboard && data.dashboard.id;
            const wasEditing = Boolean(editorState.id);
            closeEditor();
            toast(data.message || '看板已保存', 'success');
            await loadDashboards();
            // 新建的看板直接在新窗口打开，省一次点击；编辑现有看板只刷新列表。
            if (savedId && !wasEditing) window.open(dashboardUrl(savedId), '_blank', 'noopener');
        } catch (error) {
            errorLabel.textContent = `保存失败: ${error.message || error}`;
        }
    }

    // ---------- 表单回写 ----------

    function applyFieldChange(target) {
        if (!editorState) return false;
        const index = Number(target.dataset.blockIndex);
        const block = editorState.blocks[index];
        if (!block) return false;
        // 每列表宽输入使用真实 SQL 列名作键，不进入固定 data-field 分支。
        if (target.dataset.columnWidth) {
            const widths = Object.assign({}, block.column_widths);
            const name = target.dataset.columnWidth;
            const value = String(target.value || '').trim();
            if (value) {
                widths[name] = clampInt(value, 60, 60, 1200);
                target.value = String(widths[name]);
            } else {
                delete widths[name];
            }
            block.column_widths = widths;
            return 'preview';
        }

        // 变量覆盖值走单独一条分支：键名是脚本里的变量名，不是固定字段。
        if (target.dataset.paramName) {
            const name = target.dataset.paramName;
            const params = Object.assign({}, block.params);
            const value = String(target.value || '').trim();
            // 清空就把键删掉，而不是留一个空串：留空串会把脚本的默认值也顶掉。
            if (value) params[name] = value; else delete params[name];
            block.params = params;
            block._paramsOpen = true;
            // 变量变了 SQL 就变了，缓存的列名/样例行都作废，重新试跑一次。
            previewCache.delete(previewKey(block));
            renderEditorBlocks();
            ensurePreview(block.script_id, index);
            return false;
        }

        const key = target.dataset.field;
        // 默认值是 'preview'：绝大多数字段（字号、对齐、透明度、每页行数…）改完只影响
        // 预览长相，不影响表单里有哪些字段，所以只重画预览、不重建表单 DOM。
        // 为何不用 false：false 等于什么都不画，用户选了字号档位后预览一动不动，
        // 看起来就是"配了没生效"——实际值已经存进 editorState 也存进了配置文件。
        // 也不能用 true（=renderEditorBlocks）：那会重建表单，手输字号时输入框会失焦。
        let needsRerender = 'preview';

        if (key === 'script_id') {
            const oldScript = scriptCatalog.find(item => item.id === block.script_id);
            const newScript = scriptCatalog.find(item => item.id === target.value);
            const oldName = oldScript ? oldScript.name : '';
            // 空标题或仍等于旧脚本名，说明用户没有手工改名，跟随新脚本；自定义标题完整保留。
            if (!String(block.title || '').trim() || (oldName && block.title === oldName)) {
                block.title = newScript ? newScript.name : '';
            }
            block.script_id = target.value;
            // 换脚本等于换数据源，之前选的列不一定还存在，全部清掉重新猜。
            block.value_column = ''; block.value_columns = []; block.label_column = '';
            block.columns = []; block.column_widths = {}; block.compare_column = ''; block.detail_column = '';
            block.status_column = ''; block.sort = {};
            previewRequests.set(block.id, (previewRequests.get(block.id) || 0) + 1);
            renderEditorBlocks();
            ensurePreview(block.script_id, index);
            return false;
        }
        if (key === 'columns' || key === 'value_columns') {
            block[key] = Array.from(target.selectedOptions).map(option => option.value).slice(0, key === 'value_columns' ? 8 : 40);
            if (key === 'columns') {
                if (block.columns.length) {
                    const allowed = new Set(block.columns);
                    block.column_widths = Object.fromEntries(
                        Object.entries(block.column_widths || {}).filter(([name]) => allowed.has(name)));
                }
                needsRerender = true;
            }
        } else if (key === 'show_labels' || key === 'show_legend') {
            block[key] = target.checked;
        } else if (key === 'width') {
            block.layout = Object.assign({}, block.layout, { w: clampInt(target.value, 6, 1, 12) });
            needsRerender = true;
        } else if (key === 'height_px') {
            block.layout = Object.assign({}, block.layout, { height_px: clampInt(target.value, 184, 120, 1600) });
            needsRerender = true;
        } else if (key === 'sort_column') {
            block.sort = target.value ? { column: target.value, direction: (block.sort && block.sort.direction) || 'desc' } : {};
            needsRerender = true;
        } else if (key === 'sort_direction') {
            block.sort = Object.assign({}, block.sort, { direction: target.value });
        } else if (key === 'page_size') {
            block.page_size = Math.max(1, Math.min(200, Number(target.value) || 20));
        } else if (key === 'bg_opacity') {
            block.bg_opacity = clampInt(target.value, 100, 10, 100);
        } else if (key === 'marquee_speed') {
            block.marquee_speed = clampInt(target.value, 30, 4, 400);
        } else if (key === 'title_px' || key === 'header_px' || key === 'cell_px') {
            // 空串要落成 0（= 用档位），不能让 clampInt 把它抬到下限。
            block[key] = target.value === '' ? 0 : clampInt(target.value, 0, 0, 200);
        } else if (key === 'value_px') {
            block[key] = target.value === '' ? 0 : clampInt(target.value, 0, 0, 400);
        } else if (key === 'bg_preset' || key === 'table_mode' || key === 'list_mode') {
            // 这几项会改变后面还要不要显示别的字段（自定义色、滚动速度…），所以要重画。
            block[key] = target.value;
            // 重画会把折叠区收起来，选了底色档还得再展开一次才能填自定义色——所以先钉住展开状态。
            block._styleOpen = key === 'bg_preset';
            needsRerender = true;
        } else if (key === 'target_value') {
            block.target_value = target.value === '' && block.type === 'progress' ? '100' : target.value;
        } else if (key === 'aggregate' || key === 'compare_column') {
            block[key] = target.value;
            needsRerender = true;  // 这两项会改变后续要显示哪些字段
        } else if (key.endsWith('_color')) {
            // 手填的色值先过白名单：填错（比如只填了 #38b）就当没填，跟随主题。
            const value = safeColor(target.value);
            if (target.value.trim() && !value) toast('颜色要写成 #38bdf8 这样的十六进制色值', 'warning');
            block[key] = value;
            needsRerender = true;  // 重画才能同步色块高亮和小色片
        } else {
            block[key] = target.value;
            if (key === 'title') needsRerender = 'title';
        }
        return needsRerender;
    }

    /** 把第 from 块挪到第 to 个位置，并同步重绘卡片列表。 */
    function moveBlock(from, to) {
        if (!editorState) return;
        const blocks = editorState.blocks;
        if (from === to || from < 0 || from >= blocks.length || to < 0 || to > blocks.length) return;
        const [moved] = blocks.splice(from, 1);
        blocks.splice(from < to ? to - 1 : to, 0, moved);
        renderEditorBlocks();
    }

    /**
     * 布局条的拖动与改宽。
     *
     * 换位置用 pointer 事件而不是原生 HTML5 拖放：原生拖放会拖出一张半透明快照，
     * 邻块不会实时让位，落点只能靠左右两条竖线提示，拖起来发涩。这里让方块本体
     * 跟着指针走，邻块用 FLIP（先记旧位置，改完 DOM 顺序再从旧位置滑到新位置）
     * 实时让开，松手之前就能看到最终排布。
     * 改宽度同样用 pointer 事件按栏宽折算，比在下拉框里试更直观。
     */
    function bindLayoutEvents() {
        const strip = el('dashboardLayoutStrip');
        if (!strip) return;

        /** 让位动画：mutate 里改 DOM 顺序，改完每块从旧位置滑到新位置。skip 是拖着的那块。 */
        function flipCells(mutate, skip) {
            const cells = Array.from(strip.children);
            const before = cells.map(cell => cell.getBoundingClientRect());
            mutate();
            cells.forEach((cell, i) => {
                if (cell === skip) return;
                const after = cell.getBoundingClientRect();
                const dx = before[i].left - after.left;
                const dy = before[i].top - after.top;
                if (!dx && !dy) return;
                cell.style.transition = 'none';
                cell.style.transform = `translate(${dx}px, ${dy}px)`;
                // 必须等下一帧再放开动画，同一帧里设起点又设终点会被合并成"没动过"。
                requestAnimationFrame(() => {
                    cell.style.transition = '';
                    cell.style.transform = '';
                });
            });
        }

        strip.addEventListener('pointerdown', event => {
            const grip = event.target.closest('[data-layout-grip]');
            if (!grip || !editorState) return;
            const cell = grip.closest('[data-layout-index]');
            if (!cell || editorState.blocks.length < 2) return;
            event.preventDefault();

            const home = cell.getBoundingClientRect();
            // 抓点相对方块左上角的偏移：按这个偏移贴住指针，方块才不会一上手就跳一下。
            let anchorX = event.clientX - home.left;
            let anchorY = event.clientY - home.top;
            let frame = 0;
            let pointer = { x: event.clientX, y: event.clientY };
            strip.classList.add('is-sorting');
            cell.classList.add('is-dragging');
            grip.setPointerCapture(event.pointerId);

            /** 把方块摆到指针下。DOM 顺序变了之后它的静止位置也变了，所以每次都重新量。 */
            const follow = () => {
                const rect = cell.getBoundingClientRect();
                const current = new DOMMatrixReadOnly(getComputedStyle(cell).transform);
                const baseX = rect.left - current.m41;
                const baseY = rect.top - current.m42;
                cell.style.transform = `translate(${pointer.x - anchorX - baseX}px, ${pointer.y - anchorY - baseY}px)`;
            };

            const onMove = moveEvent => {
                pointer = { x: moveEvent.clientX, y: moveEvent.clientY };
                if (frame) return;
                // 一帧只算一次：pointermove 一秒能来上百次，跟着算会掉帧。
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    // 指针压到哪块身上，就跟那块换位置——越过中线才换，避免边界来回抖。
                    const target = Array.from(strip.children).find(node => {
                        if (node === cell) return false;
                        const rect = node.getBoundingClientRect();
                        if (pointer.y < rect.top || pointer.y > rect.bottom) return false;
                        return pointer.x > rect.left && pointer.x < rect.right;
                    });
                    if (target) {
                        const rect = target.getBoundingClientRect();
                        const after = pointer.x > rect.left + rect.width / 2;
                        const wantBefore = after ? target.nextSibling : target;
                        if (wantBefore !== cell) {
                            flipCells(() => strip.insertBefore(cell, wantBefore), cell);
                        }
                    }
                    follow();
                });
            };

            const onUp = () => {
                grip.removeEventListener('pointermove', onMove);
                grip.removeEventListener('pointerup', onUp);
                grip.removeEventListener('pointercancel', onUp);
                if (frame) { cancelAnimationFrame(frame); frame = 0; }
                // 按落地后的 DOM 顺序重排数据：cell 上的 layoutIndex 还是拖动前的编号，
                // 拿它去原数组取，顺序就是用户在条子上看到的顺序。
                const snapshot = editorState.blocks.slice();
                const activeBlock = snapshot[activeBlockIndex()];
                const ordered = Array.from(strip.children)
                    .map(node => snapshot[Number(node.dataset.layoutIndex)])
                    .filter(Boolean);
                if (ordered.length === snapshot.length) {
                    editorState.blocks = ordered;
                    // 选中的是"哪一块"而不是"第几个"，换完位置得跟着它走。
                    const moved = ordered.indexOf(activeBlock);
                    if (moved >= 0) editorState.activeIndex = moved;
                }
                cell.classList.remove('is-dragging');
                strip.classList.remove('is-sorting');
                // 先让方块滑回槽位，动画走完再重绘卡片列表——立刻重绘会把动画掐掉。
                cell.style.transform = '';
                setTimeout(renderEditorBlocks, 200);
            };

            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
            grip.addEventListener('pointercancel', onUp);
        });

        strip.addEventListener('click', event => {
            if (event.target.closest('[data-layout-grip],[data-layout-resize]')) return;
            const cell = event.target.closest('[data-layout-index]');
            if (!cell || !editorState) return;
            // 点方块＝选中它，右边换成它的配置。
            const index = Number(cell.dataset.layoutIndex);
            if (index === activeBlockIndex()) return;
            editorState.activeIndex = index;
            renderEditorBlocks();
            // 闪一下的是卡片本体而不是外层容器：容器占满右栏，整栏发光太扎眼，
            // 而且 .is-flash 的样式本来就挂在 .dash-block-editor 上。
            const list = el('dashboardBlockList');
            const card = list && list.querySelector('.dash-block-editor');
            if (card) card.classList.add('is-flash');
            setTimeout(() => { if (card) card.classList.remove('is-flash'); }, 900);
        });

        strip.addEventListener('pointerdown', event => {
            const handle = event.target.closest('[data-layout-resize]');
            if (!handle || !editorState) return;
            event.preventDefault();
            const index = Number(handle.dataset.layoutResize);
            const block = editorState.blocks[index];
            if (!block) return;
            const startX = event.clientX;
            const startWidth = Math.max(1, Math.min(GRID_COLUMNS, (block.layout && block.layout.w) || 6));
            // 一栏的像素宽度：整条宽度含 11 道间隙，折算时一并算进去。
            const columnPx = (strip.getBoundingClientRect().width - 11 * 6) / GRID_COLUMNS;
            handle.setPointerCapture(event.pointerId);

            const onMove = moveEvent => {
                const delta = Math.round((moveEvent.clientX - startX) / Math.max(1, columnPx));
                const next = Math.max(1, Math.min(GRID_COLUMNS, startWidth + delta));
                if (next === ((block.layout && block.layout.w) || 6)) return;
                block.layout = Object.assign({}, block.layout, { w: next });
                // 只改这一格的栏宽，不重建整条：重建会把正在拖的那格连同 pointer capture
                // 一起换掉，手感断成一节一节的。
                const cell = strip.querySelector(`[data-layout-index="${index}"]`);
                if (!cell) return;
                cell.style.gridColumn = `span ${next}`;
                const meta = cell.querySelector('.dash-layout-cell-meta');
                if (meta) meta.textContent = `宽 ${next}/12`;
            };
            const onUp = () => {
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                // 拖完再重绘卡片，把宽度下拉框同步过去。拖动过程中不重绘，避免闪。
                renderEditorBlocks();
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
        });
    }

    function bindEditorEvents() {
        const modal = el('dashboardEditorModal');
        if (!modal) return;

        modal.addEventListener('change', event => {
            // 背景图上传：input[type=file] 不走下面的 data-field 流程
            if (event.target.id === 'dashboardBgUpload') {
                uploadBgImage(event.target.files && event.target.files[0]);
                event.target.value = '';  // 清掉才能连续上传同名文件
                return;
            }
            // 免登录开关：勾上/取消都要跟着更新下面显示的地址
            if (event.target.id === 'dashboardPublicInput') {
                if (editorState) editorState.public = event.target.checked;
                renderPublicUrl();
                return;
            }
            // 看板级字段（背景图铺法/压暗/模糊），改完要重画选择器同步显示
            const dashField = event.target.closest('[data-dash-field]');
            if (dashField && editorState) {
                const key = dashField.dataset.dashField;
                if (key === 'bg_fit') editorState.bg_fit = allow(dashField.value, BG_FITS, 'cover');
                else if (key === 'bg_dim') editorState.bg_dim = clampInt(dashField.value, 35, 0, 85);
                else if (key === 'bg_blur') editorState.bg_blur = clampInt(dashField.value, 0, 0, 20);
                else if (key === 'name_size') editorState.name_size = allow(dashField.value, NAME_SIZES, 'md');
                // 清空输入框要回到"没填"（0），而不是保留上一次的值。
                else if (key === 'name_px') editorState.name_px = String(dashField.value).trim() ? clampInt(dashField.value, 0, 0, 200) : 0;
                else if (key === 'name_align') editorState.name_align = allow(dashField.value, ALIGNS, 'left');
                else if (key === 'name_color') { editorState.name_color = safeColor(dashField.value); renderNameColor(); }
                renderVisualPreview();
                return;
            }
            // 变量输入框只带 data-param-name（键名是脚本里的变量名，不是固定字段），
            // 所以这里必须两个都选；只选 data-field 会让变量值永远回不到 block.params。
            const target = event.target.closest('[data-field],[data-param-name],[data-column-width]');
            if (!target) return;
            const result = applyFieldChange(target);
            if (result === 'title') {
                // 只改几处文字，不整块重绘：重绘会让输入框失去焦点。
                const index = Number(target.dataset.blockIndex);
                const card = modal.querySelector(`[data-editor-index="${index}"] .dash-block-editor-name`);
                const block = editorState.blocks[index];
                const type = BLOCK_TYPES.find(item => item.value === block.type) || BLOCK_TYPES[0];
                if (card) card.textContent = `${block.title || '未命名内容块'} · ${type.label}`;
                // 布局条和预览里的标题一起跟上，边打字边能看到效果。
                const cellName = modal.querySelector(`[data-layout-index="${index}"] .dash-layout-cell-name`);
                if (cellName) cellName.textContent = block.title || `第 ${index + 1} 块`;
                const previewTitle = modal.querySelector(`#dashboardPreviewGrid [data-block-id="${block.id}"] .dash-block-title`);
                if (previewTitle) previewTitle.textContent = block.title || '未命名';
            } else if (result === 'preview') {
                // 只重画预览：表单里有哪些字段没变，重建表单会让手输字号的输入框失焦。
                renderVisualPreview();
            } else if (result) {
                renderEditorBlocks();
            }
        });

        // details 的展开状态要记住，否则改一次颜色重绘就合上了。toggle 不冒泡，用捕获监听。
        modal.addEventListener('toggle', event => {
            if (!event.target.closest || !editorState) return;
            const colorBox = event.target.closest('[data-color-box]');
            if (colorBox) {
                const block = editorState.blocks[Number(colorBox.dataset.colorBox)];
                if (block) block._colorOpen = colorBox.open;
                return;
            }
            const styleBox = event.target.closest('[data-style-box]');
            if (styleBox) {
                const block = editorState.blocks[Number(styleBox.dataset.styleBox)];
                if (block) block._styleOpen = styleBox.open;
                return;
            }
            const paramBox = event.target.closest('[data-param-box]');
            if (paramBox) {
                const block = editorState.blocks[Number(paramBox.dataset.paramBox)];
                if (block) block._paramsOpen = paramBox.open;
            }
        }, true);

        modal.addEventListener('click', event => {
            // 色块 / 「跟随主题」：data-color-set 为空串就是清空，回到主题色。
            const colorBtn = event.target.closest('[data-color-set]');
            if (colorBtn) {
                const index = Number(colorBtn.dataset.blockIndex);
                const block = editorState && editorState.blocks[index];
                if (block) {
                    block[colorBtn.dataset.colorKey] = safeColor(colorBtn.dataset.colorSet);
                    renderEditorBlocks();
                }
                return;
            }
            // 看板名称的「跟随主题」：清掉配色，交回给主题（深色白字 / 浅色深字）。
            if (event.target.closest('#dashboardNameColorClear')) {
                if (editorState) {
                    editorState.name_color = '';
                    renderNameColor();
                    renderVisualPreview();
                }
                return;
            }
            const themeBtn = event.target.closest('[data-theme-set]');
            if (themeBtn) {
                if (editorState) {
                    editorState.theme = themeBtn.dataset.themeSet;
                    renderThemePicker();
                    // 没配名称颜色时，色块显示的是"主题会给的那个色"，换主题得跟着变。
                    renderNameColor();
                    renderVisualPreview();
                }
                return;
            }
            // 删除按钮在图块内部，要先判它，否则会被下面的"选中这张图"吃掉
            const bgDel = event.target.closest('[data-bg-delete]');
            if (bgDel) {
                event.preventDefault();
                deleteBgImage(bgDel.dataset.bgDelete);
                return;
            }
            const bgOpt = event.target.closest('[data-bg-set]');
            if (bgOpt) {
                if (editorState) {
                    editorState.bg_image = bgOpt.dataset.bgSet;
                    renderBgPicker();
                    renderVisualPreview();
                }
                return;
            }
            const typeBtn = event.target.closest('[data-set-type]');
            if (typeBtn) {
                const index = Number(typeBtn.dataset.blockIndex);
                const block = editorState.blocks[index];
                const nextType = typeBtn.dataset.setType;
                if (block && block.type !== nextType) {
                    block.type = nextType;
                    // 不同展示方式的合理尺寸差别很大，切换时顺手给一套默认尺寸。
                    block.layout = defaultLayoutFor(nextType);
                    renderEditorBlocks();
                    if (block.script_id) ensurePreview(block.script_id, index);
                }
                return;
            }
            const moveBtn = event.target.closest('[data-move-block]');
            if (moveBtn) {
                const index = Number(moveBtn.dataset.moveBlock);
                const target = index + Number(moveBtn.dataset.moveDir);
                if (target >= 0 && target < editorState.blocks.length) {
                    const [moved] = editorState.blocks.splice(index, 1);
                    editorState.blocks.splice(target, 0, moved);
                    // 挪完继续配置同一块，选中位置跟着它走。
                    editorState.activeIndex = target;
                    renderEditorBlocks();
                }
                return;
            }
            // 上一块 / 下一块：不改顺序，只换右边在配置哪一块。
            const stepBtn = event.target.closest('[data-step-block]');
            if (stepBtn) {
                const next = activeBlockIndex() + Number(stepBtn.dataset.stepBlock);
                if (next >= 0 && next < editorState.blocks.length) {
                    editorState.activeIndex = next;
                    renderEditorBlocks();
                }
                return;
            }
            const removeBtn = event.target.closest('[data-remove-block]');
            if (removeBtn) {
                const index = Number(removeBtn.dataset.removeBlock);
                editorState.blocks.splice(index, 1);
                // 删掉后选中它原来的位置（删的是最后一块就往前退一格）。
                editorState.activeIndex = Math.min(index, editorState.blocks.length - 1);
                renderEditorBlocks();
            }
        });

        el('dashboardAddTypes').addEventListener('click', event => {
            const btn = event.target.closest('[data-add-type]');
            if (btn) addBlock(btn.dataset.addType);
        });
        // 看板名称边打边在预览里跟上。用 input 而不是 change：change 要等失焦才发，
        // 打完字不点别处就看不到效果。这里只补文字/颜色/位置，不整块重绘（重绘会丢焦点）。
        const nameInput = el('dashboardNameInput');
        const descInput = el('dashboardDescInput');
        [nameInput, descInput].forEach(input => input?.addEventListener('input', () => {
            const stage = el('dashboardPreviewStage');
            if (stage && editorState) renderPreviewName(stage);
        }));
        // 手填像素同理：change 要失焦才发，边调边看不到。
        const namePxInput = el('dashboardNamePxInput');
        if (namePxInput) namePxInput.addEventListener('input', () => {
            if (!editorState) return;
            editorState.name_px = String(namePxInput.value).trim() ? clampInt(namePxInput.value, 0, 0, 200) : 0;
            const stage = el('dashboardPreviewStage');
            if (stage) renderPreviewName(stage);
        });
        bindLayoutEvents();
        el('dashboardPreviewSize')?.addEventListener('change', applyPreviewSize);
        el('dashboardPreviewWide')?.addEventListener('click', togglePreviewWide);
        el('dashboardPreviewZoom')?.addEventListener('click', togglePreviewZoom);
        window.addEventListener('resize', applyPreviewSize);
        el('dashboardEditorSave').addEventListener('click', saveEditor);
        el('dashboardEditorCancel').addEventListener('click', closeEditor);
        el('dashboardEditorClose').addEventListener('click', closeEditor);
        modal.addEventListener('click', event => { if (event.target === modal) closeEditor(); });
    }

    function bindViewerEvents() {
        const cards = el('dashboardCardGrid');
        if (cards) {
            cards.addEventListener('click', event => {
                // 复制/编辑/删除是叠在卡片（一个 <a>）上的小按钮，
                // 命中它们时必须阻止默认跳转，否则会顺带打开新窗口。
                const copy = event.target.closest('[data-dashboard-copy]');
                if (copy) { event.preventDefault(); copyDashboardUrl(copy.dataset.dashboardCopy); return; }
                const json = event.target.closest('[data-dashboard-json]');
                if (json) { event.preventDefault(); copyDashboardJson(json.dataset.dashboardJson); return; }
                const edit = event.target.closest('[data-dashboard-edit]');
                if (edit) { event.preventDefault(); openEditorFor(edit.dataset.dashboardEdit); return; }
                const remove = event.target.closest('[data-dashboard-delete]');
                if (remove) { event.preventDefault(); deleteDashboard(remove.dataset.dashboardDelete); return; }
                // 其余点击落在 <a target="_blank"> 上，交给浏览器原生行为开新窗口。
            });
        }
        const refreshBtn = el('dashboardRefreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => loadDashboards());

        const createBtn = el('dashboardCreateBtn');
        if (createBtn) createBtn.addEventListener('click', async () => {
            await loadScriptCatalog(true);
            if (!scriptCatalog.length) {
                toast('还没有可用的自定义SQL脚本，请先去「自定义SQL」里保存查询', 'warning');
                return;
            }
            openEditor(null);
        });

        const importBtn = el('dashboardImportBtn');
        if (importBtn) importBtn.addEventListener('click', () => importDashboardJson());
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        bindViewerEvents();
        bindEditorEvents();
    }

    // ---------- 对外入口（供 app.js 的导航调度调用） ----------

    // 看板列表页。区块在 index.html 的 #results 里，而 hideAllContent() 会把 #results
    // 一起隐藏，所以要跟其他工作区一样把外层一并放开，否则内容区一片空白。
    window.showCustomDashboard = function showCustomDashboard() {
        if (typeof window.hideAllContent === 'function') window.hideAllContent();
        const page = el('customDashboardContent');
        if (!page) return;
        el('results')?.classList.remove('hidden');
        page.classList.remove('hidden');
        if (typeof window.setPageContext === 'function') {
            window.setPageContext('自定义看板', '每个看板都有独立地址，点小块在新窗口打开。');
        }
        initialize();
        loadDashboards();
    };

    // 供看板独立页（/dashboard/<id>）复用同一套渲染器，避免两处各写一份图表代码。
    // 独立页复用这里的渲染器，避免两套代码各画一遍表格/指标，样式和口径必然会走偏。
    window.DashboardRender = { blockShell, renderBlockBody, escapeHtml, bindTableScroll, bindMarquee, bindClocks, stopMarquee, THEMES, LIGHT_THEMES };

    document.addEventListener('DOMContentLoaded', () => {
        if (el('customDashboardContent')) initialize();
    });
})();
