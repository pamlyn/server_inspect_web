"""
日志存储模块 - 路由定义

提供巡检日志的查询、详情、删除接口。日志写入仍由各巡检模块通过
record_inspection_log 调用，本模块仅负责读取与解析展示。
"""

from flask import Blueprint, jsonify, request, send_file
import datetime

from modules.auth.helpers import login_required
from modules.config_mgmt.helpers import get_config
from modules.log_storage.helpers import (
    _get_log_db_config, query_inspection_logs, get_inspection_summary, export_inspection_logs,
    get_inspection_log_detail, get_continuous_resource_history, get_resource_history,
    aggregate_resource_samples, delete_inspection_logs,
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


@log_bp.route('/summary', methods=['GET'])
@login_required
def inspection_summary():
    """返回首页所需的近 N 天巡检汇总。"""
    cfg, err = _log_db_or_403()
    if err:
        return err
    try:
        days = max(1, min(90, int(request.args.get('days', 7))))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': '统计天数无效'}), 400
    try:
        db_type, db_config = cfg
        start_time = datetime.datetime.now() - datetime.timedelta(days=days)
        summary = get_inspection_summary(db_type, db_config, start_time)
        return jsonify({'success': True, 'days': days, **summary})
    except Exception as error:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'加载巡检统计失败: {error}'}), 500

@log_bp.route('/resource-history', methods=['GET'])
@login_required
def resource_history():
    """返回按请求范围与时间桶聚合的资源历史，依次回退到本地时序库和旧巡检记录。"""
    hours_by_range = {'24h': 24, '7d': 24 * 7, '30d': 24 * 30}
    monitoring = get_config('resourceHistoryMonitoring', {}) or {}
    max_hours = max(1, int(monitoring.get('retention_days', 90))) * 24
    try:
        range_seconds = request.args.get('range_seconds')
        hours = int(request.args.get('hours', hours_by_range.get(request.args.get('range', '24h'), 24)))
        requested_range_seconds = int(range_seconds) if range_seconds is not None else hours * 3600
        requested_bucket_seconds = max(0, int(request.args.get('bucket_seconds', 0)))
    except ValueError:
        return jsonify({'success': False, 'error': '时间范围或数据间隔无效'}), 400
    collection_interval_seconds = max(30, int(monitoring.get('interval_seconds', 60)))
    if requested_range_seconds < collection_interval_seconds:
        return jsonify({'success': False, 'error': f'查看范围不得小于采集间隔（{collection_interval_seconds} 秒）'}), 400
    requested_range_seconds = min(requested_range_seconds, max_hours * 3600)
    hours = max(1, (requested_range_seconds + 3599) // 3600)
    if requested_bucket_seconds not in (0, 60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400):
        return jsonify({'success': False, 'error': '数据间隔无效'}), 400

    # 允许在 24 小时窗口内保留每分钟一个点；自动聚合绝不粗于实际采集间隔。
    max_points = 1440
    minimum_bucket_seconds = max(collection_interval_seconds, (requested_range_seconds + max_points - 1) // max_points)
    effective_bucket_seconds = max(requested_bucket_seconds, minimum_bucket_seconds)
    try:
        start_time = datetime.datetime.now() - datetime.timedelta(seconds=requested_range_seconds)
        cfg = _get_log_db_config()
        samples = []
        source = 'none'
        if cfg is not None:
            db_type, db_config = cfg
            try:
                samples = get_continuous_resource_history(db_type, db_config, start_time, max_points=50000)
            except Exception as error:
                print(f'连续资源历史数据库读取失败，回退本地存储: {error}')
            if samples:
                source = 'continuous_database'
        if not samples:
            from modules.resource_metrics.local_storage import get_resource_history as get_local_resource_history
            samples = get_local_resource_history(start_time, max_points=50000)
            if samples:
                source = 'continuous_local'
        if not samples and cfg is not None:
            samples = get_resource_history(db_type, db_config, start_time, max_points=50000)
            if samples:
                source = 'inspection_log_fallback'
        raw_sample_count = len(samples)
        samples = aggregate_resource_samples(samples, effective_bucket_seconds)
        return jsonify({
            'success': True, 'hours': hours, 'range_seconds': requested_range_seconds,
            'max_range_seconds': max_hours * 3600, 'samples': samples, 'source': source,
            'raw_sample_count': raw_sample_count, 'sample_count': len(samples),
            'requested_bucket_seconds': requested_bucket_seconds,
            'effective_bucket_seconds': effective_bucket_seconds,
            'collection_interval_seconds': collection_interval_seconds if source.startswith('continuous') else None,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'加载资源历史失败: {e}', 'samples': []}), 500


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
