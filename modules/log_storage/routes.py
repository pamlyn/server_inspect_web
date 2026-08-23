"""
日志存储模块 - 路由定义

提供巡检日志的查询、详情、删除接口。日志写入仍由各巡检模块通过
record_inspection_log 调用，本模块仅负责读取与解析展示。
"""

from flask import Blueprint, jsonify, request, send_file
import datetime

from modules.auth.helpers import login_required
from modules.log_storage.helpers import (
    _get_log_db_config, query_inspection_logs, export_inspection_logs,
    get_inspection_log_detail, delete_inspection_logs,
)
from modules.log_storage.parser import parse_log_detail, _target_label, _type_label, _trigger_label, _status_label
from modules.log_storage.exporter import build_log_list_excel, EXCEL_MIMETYPE

log_bp = Blueprint('logs', __name__, url_prefix='/api/logs')


def _log_db_or_403():
    """获取日志库配置，未启用时返回错误响应元组。"""
    cfg = _get_log_db_config()
    if cfg is None:
        return None, (jsonify({'success': False, 'error': '日志数据库未启用，请在系统配置中开启日志库',
                               'logs': [], 'total': 0}), 200)
    return cfg, None


def _get_log_filters():
    """从请求参数提取列表和导出共用的筛选条件。"""
    filters = {
        'inspection_type': request.args.get('inspection_type'),
        'trigger_source': request.args.get('trigger_source'),
        'status': request.args.get('status'),
        'operator': request.args.get('operator'),
        'target': request.args.get('target'),
        'keyword': request.args.get('keyword'),
        'start_time': request.args.get('start_time'),
        'end_time': request.args.get('end_time'),
    }
    return {key: value for key, value in filters.items() if value}


def _serialize_log_datetimes(log):
    """就地序列化日志中的时间对象。"""
    for key, value in list(log.items()):
        if isinstance(value, datetime.datetime):
            log[key] = value.strftime('%Y-%m-%d %H:%M:%S')
    return log


def _enrich_log_labels(log):
    """补充导出和页面展示共用的中文标签。"""
    log['target_label'] = _target_label(log.get('target'))
    log['type_label'] = _type_label(log.get('inspection_type'))
    log['source_label'] = _trigger_label(log.get('trigger_source'))
    log['status_label'] = _status_label(log.get('status'))
    return log


@log_bp.route('', methods=['GET'])
@login_required
def list_logs():
    """分页查询巡检日志列表。"""
    cfg, err = _log_db_or_403()
    if err:
        return err
    db_type, db_config = cfg

    try:
        page = int(request.args.get('page', 1))
        page_size = int(request.args.get('page_size', 20))
        page = max(1, page)
        page_size = max(1, min(page_size, 200))
    except (ValueError, TypeError):
        page, page_size = 1, 20

    filters = _get_log_filters()

    try:
        logs, total = query_inspection_logs(db_type, db_config, filters, page, page_size)
        for log in logs:
            _enrich_log_labels(_serialize_log_datetimes(log))
        return jsonify({
            'success': True,
            'logs': logs,
            'total': total,
            'page': page,
            'page_size': page_size,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'查询日志失败: {e}',
                        'logs': [], 'total': 0}), 500


@log_bp.route('/export', methods=['GET'])
@login_required
def export_logs():
    """按当前筛选条件导出巡检日志列表。"""
    cfg, err = _log_db_or_403()
    if err:
        return err
    db_type, db_config = cfg

    try:
        logs = export_inspection_logs(db_type, db_config, _get_log_filters())
        for log in logs:
            _enrich_log_labels(_serialize_log_datetimes(log))
        output, filename = build_log_list_excel(logs)
        return send_file(output, mimetype=EXCEL_MIMETYPE, as_attachment=True, download_name=filename)
    except ValueError as e:
        return jsonify({'success': False, 'error': str(e)}), 400
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'导出日志失败: {e}'}), 500


@log_bp.route('/<int:log_id>', methods=['GET'])
@login_required
def log_detail(log_id):
    """查询单条日志详情（含解析后的友好内容）。"""
    cfg, err = _log_db_or_403()
    if err:
        return err
    db_type, db_config = cfg

    try:
        log_row = get_inspection_log_detail(db_type, db_config, log_id)
        if not log_row:
            return jsonify({'success': False, 'error': '日志不存在'}), 404

        # 序列化 datetime
        for k, v in list(log_row.items()):
            if isinstance(v, datetime.datetime):
                log_row[k] = v.strftime('%Y-%m-%d %H:%M:%S')

        parsed = parse_log_detail(log_row)
        return jsonify({'success': True, 'log': log_row, 'parsed': parsed})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'查询日志详情失败: {e}'}), 500


@log_bp.route('', methods=['DELETE'])
@login_required
def clear_logs():
    """清理日志：按 before_date 或 keep_days 保留策略删除。"""
    cfg, err = _log_db_or_403()
    if err:
        return err
    db_type, db_config = cfg

    data = request.get_json() or {}
    before_date = data.get('before_date')
    keep_days = data.get('keep_days')

    if not before_date and keep_days is None:
        return jsonify({'success': False, 'error': '需指定 before_date 或 keep_days'}), 400

    try:
        deleted = delete_inspection_logs(db_type, db_config, before_date=before_date, keep_days=keep_days)
        return jsonify({'success': True, 'deleted': deleted,
                        'message': f'已清理 {deleted} 条日志'})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'清理日志失败: {e}'}), 500
