"""
调度模块 - 路由定义
"""

from flask import Blueprint, jsonify
import datetime
import threading
import time
import json

from modules.auth.helpers import login_required, permission_required
from modules.config_mgmt.helpers import get_config, notification_cooldowns
from modules.inspection.helpers import get_inspection_functions
from modules.custom_scripts.helpers import run_custom_scripts
from modules.log_storage.helpers import record_inspection_log, derive_status
from dingtalk import dingtalk_notifier

scheduler_bp = Blueprint('scheduler', __name__, url_prefix='/api/scheduler')

# 全局scheduler变量
scheduler = None

# 全局实时监控线程变量
real_time_monitor_thread = None
real_time_monitor_running = False          # 状态镜像，供外部查询；停止控制改用 _realtime_stop_event
_realtime_stop_event = None               # 当前监控线程的停止事件（每线程一个，可中断休眠）
_realtime_lock = threading.Lock()         # 保护下面的去重状态
_realtime_last_signature = None           # 上次通知的异常内容签名（None=无异常或已重置）
_realtime_last_notify_time = 0.0          # 上次通知的时间戳


@scheduler_bp.route('/status', methods=['GET'])
@login_required
@permission_required('config_inspection_strategy')
def scheduler_status():
    """获取定时任务状态"""
    global scheduler
    SCHEDULER_CONFIG = get_config('scheduler')
    DAILY_INSPECTION_CONFIG = get_config('dailyInspection')
    INSPECTION_ITEMS = get_config('inspectionItems')
    SCHEDULED_INSPECTION_ITEMS = get_config('scheduledInspectionItems')
    DAILY_INSPECTION_ITEMS = get_config('dailyInspectionItems')

    try:
        if not scheduler:
            return jsonify({
                'running': False,
                'enabled': SCHEDULER_CONFIG.get("enabled", False),
                'daily_enabled': DAILY_INSPECTION_CONFIG.get("enabled", False),
                'message': '定时任务未启动',
                'jobs': []
            })

        jobs = []
        for job in scheduler.get_jobs():
            jobs.append({
                'id': job.id,
                'name': job.name,
                'next_run_time': job.next_run_time.strftime('%Y-%m-%d %H:%M:%S') if job.next_run_time else None,
                'trigger': str(job.trigger)
            })

        return jsonify({
            'running': scheduler.running,
            'enabled': SCHEDULER_CONFIG.get("enabled", False),
            'daily_enabled': DAILY_INSPECTION_CONFIG.get("enabled", False),
            'cron': SCHEDULER_CONFIG.get("cron", ""),
            'daily_hour': DAILY_INSPECTION_CONFIG.get("hour", 9),
            'daily_minute': DAILY_INSPECTION_CONFIG.get("minute", 0),
            'inspection_items': INSPECTION_ITEMS,
            'scheduled_inspection_items': SCHEDULED_INSPECTION_ITEMS,
            'daily_inspection_items': DAILY_INSPECTION_ITEMS,
            'jobs': jobs
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@scheduler_bp.route('/run', methods=['POST'])
@login_required
@permission_required('config_inspection_strategy')
def run_scheduler_now():
    """立即执行一次定时巡检"""
    try:
        thread = threading.Thread(target=run_scheduled_inspection)
        thread.start()
        return jsonify({'message': '定时巡检已启动'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@scheduler_bp.route('/run-daily', methods=['POST'])
@login_required
@permission_required('config_inspection_strategy')
def run_daily_now():
    """立即执行一次日常巡检"""
    try:
        thread = threading.Thread(target=run_daily_inspection)
        thread.start()
        return jsonify({'message': '日常巡检已启动'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def save_inspection_log_to_db(results, inspection_type, *, target=None, error=None, start_time=None):
    """保存巡检日志到数据库（定时/日常/实时巡检，含成功与失败）。

    target 默认取 inspection_type（scheduled/daily/real_time）作为巡检对象代号，经
    _target_label 映射为「定时巡检/日常巡检/实时监控」，避免与手动完整巡检
    （target='full' -> 「完整巡检」）混淆。"""
    try:
        now = datetime.datetime.now()
        if error:
            status = 'error'
            summary = f"巡检失败: {inspection_type}"
        else:
            status = derive_status(results)
            summary = f"巡检完成: {inspection_type}"
        if target is None:
            target = inspection_type
        record_inspection_log(
            inspection_type='system', trigger_source=inspection_type,
            target=target, operator=None, status=status,
            start_time=start_time or now, end_time=now,
            summary=summary,
            record_count=len(results) if isinstance(results, dict) else 0,
            result=results, error=error,
        )
    except Exception as e:
        print(f"[{datetime.datetime.now()}] 保存巡检日志出错: {e}")
        import traceback
        traceback.print_exc()


def run_scheduled_inspection():
    """执行定时巡检"""
    print(f"[{datetime.datetime.now()}] 开始执行定时巡检...")
    SCHEDULED_INSPECTION_ITEMS = get_config('scheduledInspectionItems')
    DINGTALK_CONFIG = get_config('dingtalk')
    start_time = datetime.datetime.now()

    try:
        results = {}
        for item, enabled in SCHEDULED_INSPECTION_ITEMS.items():
            if enabled and item in get_inspection_functions():
                result = get_inspection_functions()[item]()
                results[item] = result.to_dict()

        custom_results = run_custom_scripts('scheduled')
        results.update(custom_results)

        save_inspection_log_to_db(results, 'scheduled', start_time=start_time)

        has_alert = False
        alert_results = {}
        for item, result in results.items():
            if result.get('criticals') and len(result['criticals']) > 0:
                has_alert = True
                alert_results[item] = result
            elif result.get('warnings') and len(result['warnings']) > 0:
                has_alert = True
                alert_results[item] = result

        if has_alert:
            current_time = time.time()
            last_notification = notification_cooldowns.get('scheduled', 0)
            cooldown_period = 300

            if current_time - last_notification > cooldown_period:
                print(f"[{datetime.datetime.now()}] 定时巡检发现异常，发送通知...")
                if DINGTALK_CONFIG.get('enabled', False):
                    dingtalk_notifier.send_inspection_report(alert_results, "scheduled")
                notification_cooldowns['scheduled'] = current_time

        print(f"[{datetime.datetime.now()}] 定时巡检完成")
    except Exception as e:
        print(f"[{datetime.datetime.now()}] 定时巡检出错: {e}")
        import traceback
        traceback.print_exc()
        save_inspection_log_to_db(None, 'scheduled', error=str(e), start_time=start_time)


def run_daily_inspection():
    """执行日常巡检"""
    print(f"[{datetime.datetime.now()}] 开始执行日常巡检...")
    DAILY_INSPECTION_ITEMS = get_config('dailyInspectionItems')
    DAILY_INSPECTION_CONFIG = get_config('dailyInspection')
    DINGTALK_CONFIG = get_config('dingtalk')
    start_time = datetime.datetime.now()

    try:
        results = {}
        for item, enabled in DAILY_INSPECTION_ITEMS.items():
            if enabled and item in get_inspection_functions():
                result = get_inspection_functions()[item]()
                results[item] = result.to_dict()

        custom_results = run_custom_scripts('daily')
        results.update(custom_results)

        save_inspection_log_to_db(results, 'daily', start_time=start_time)

        # 是否异常通知：开启时仅在异常时通知，关闭时无论是否异常都通知
        only_error_notification = DAILY_INSPECTION_CONFIG.get('only_error_notification', False)
        has_alert = False
        alert_results = {}
        for item, result in results.items():
            if result.get('criticals') and len(result['criticals']) > 0:
                has_alert = True
                alert_results[item] = result
            elif result.get('warnings') and len(result['warnings']) > 0:
                has_alert = True
                alert_results[item] = result

        should_notify = (not only_error_notification) or has_alert
        if should_notify and DINGTALK_CONFIG.get('enabled', False):
            # 仅异常通知开启且有异常时，只发送异常项；其余情况发送全部结果
            notify_results = alert_results if (only_error_notification and has_alert) else results
            print(f"[{datetime.datetime.now()}] 日常巡检完成，发送通知...")
            dingtalk_notifier.send_inspection_report(notify_results, "daily")
        elif only_error_notification and not has_alert:
            print(f"[{datetime.datetime.now()}] 日常巡检无异常，仅异常通知已开启，跳过通知")
        print(f"[{datetime.datetime.now()}] 日常巡检完成")
    except Exception as e:
        print(f"[{datetime.datetime.now()}] 日常巡检出错: {e}")
        import traceback
        traceback.print_exc()
        save_inspection_log_to_db(None, 'daily', error=str(e), start_time=start_time)


def _alert_signature(alert_results):
    """对异常内容计算稳定签名：相同签名 = 异常内容完全一致。
    仅取每个异常项的 criticals/warnings，忽略无关字段，保证内容相同则签名相同。"""
    try:
        payload = {}
        for item, result in sorted(alert_results.items()):
            payload[item] = {
                'criticals': result.get('criticals', []),
                'warnings': result.get('warnings', []),
            }
        return json.dumps(payload, sort_keys=True, ensure_ascii=False)
    except Exception:
        # 退化方案：保证总能产出可比较的字符串，绝不因异常而漏比较
        return repr(alert_results)


def _realtime_sleep(stop_event, interval, cycle_start):
    """周期修正休眠：实际休眠 = max(0, interval - 本轮检查耗时)，保证监控周期≈interval。
    被 stop_event 唤醒时立即返回（用于线程停止），可中断。"""
    elapsed = time.time() - cycle_start
    remaining = interval - elapsed
    if remaining > 0:
        stop_event.wait(remaining)


def real_time_monitor(stop_event):
    """实时监控线程

    设计要点：
    1. 单线程保证：由 start_real_time_monitor 通过 stop_event + join 确保同一时刻只有一个
       监控线程，避免「多次保存配置 -> 多线程并存 -> 重复通知」。
    2. 内容指纹去重：异常内容（各异常项的 criticals/warnings）完全一致时，在冷却期内不重复
       通知；异常内容变化则立即通知；冷却期过后相同内容会再通知一次（周期提醒）。
    3. 周期修正：每轮休眠扣除本轮检查耗时，保证实际监控周期≈interval，不受检查耗时长短影响。
    """
    # _realtime_last_signature / _realtime_last_notify_time 必须声明 global：
    # 函数内既有读(312/331)又有写(319/332)，不声明则 Python 视为局部变量，
    # 首次读取即抛 UnboundLocalError，导致每轮必失败、回退到 10s 兜底休眠。
    global real_time_monitor_running, _realtime_last_signature, _realtime_last_notify_time
    real_time_monitor_running = True
    print(f"[{datetime.datetime.now()}] 实时监控线程启动")

    while not stop_event.is_set():
        cycle_start = time.time()
        start_time = datetime.datetime.now()
        try:
            REAL_TIME_MONITORING = get_config('realTimeMonitoring')
            if not REAL_TIME_MONITORING.get('enabled', False):
                print(f"[{datetime.datetime.now()}] 实时监控已禁用，线程准备退出")
                break

            interval = REAL_TIME_MONITORING.get('interval', 30)
            items = REAL_TIME_MONITORING.get('items', {})
            notification_config = REAL_TIME_MONITORING.get('notification', {})
            notification_enabled = notification_config.get('enabled', False)
            alert_levels = notification_config.get('alert_levels', ['warning', 'critical'])
            dingtalk_enabled = notification_config.get('dingtalk', False)
            cooldown_period = notification_config.get('cooldown_period', 300)

            results = {}
            for item, enabled in items.items():
                if stop_event.is_set():
                    break
                if enabled and item in get_inspection_functions():
                    result = get_inspection_functions()[item]()
                    results[item] = result.to_dict()

            if not stop_event.is_set():
                custom_results = run_custom_scripts('realtime')
                results.update(custom_results)

            save_inspection_log_to_db(results, 'real_time', start_time=start_time)

            if not notification_enabled:
                _realtime_sleep(stop_event, interval, cycle_start)
                continue

            has_alert = False
            alert_results = {}
            for item, result in results.items():
                if result.get('criticals') and len(result['criticals']) > 0:
                    if 'critical' in alert_levels:
                        has_alert = True
                        alert_results[item] = result
                elif result.get('warnings') and len(result['warnings']) > 0:
                    if 'warning' in alert_levels:
                        has_alert = True
                        alert_results[item] = result

            if has_alert:
                signature = _alert_signature(alert_results)
                now = time.time()
                with _realtime_lock:
                    last_sig = _realtime_last_signature
                    last_time = _realtime_last_notify_time
                    # 通知条件：内容变化（新/不同异常）立即通知；或内容相同但已超过冷却期（周期提醒）
                    content_changed = (signature != last_sig)
                    cooldown_elapsed = (now - last_time) >= cooldown_period
                    should_notify = content_changed or cooldown_elapsed
                    if should_notify:
                        _realtime_last_signature = signature
                        _realtime_last_notify_time = now

                if should_notify:
                    reason = '内容变化' if content_changed else '冷却到期'
                    print(f"[{datetime.datetime.now()}] 实时监控发现异常，发送通知（{reason}）")
                    DINGTALK_CONFIG = get_config('dingtalk')
                    if dingtalk_enabled and DINGTALK_CONFIG.get('enabled', False):
                        dingtalk_notifier.send_inspection_report(alert_results, "real_time")
            else:
                # 异常消除：重置签名，便于下次异常再次通知
                with _realtime_lock:
                    if _realtime_last_signature is not None:
                        _realtime_last_signature = None

            _realtime_sleep(stop_event, interval, cycle_start)
        except Exception as e:
            print(f"[{datetime.datetime.now()}] 实时监控线程出错: {e}")
            import traceback
            traceback.print_exc()
            save_inspection_log_to_db(None, 'real_time', error=str(e), start_time=start_time)
            # 出错后短暂休眠，避免异常死循环；被停止事件唤醒则退出
            if stop_event.wait(10):
                break

    real_time_monitor_running = False
    print(f"[{datetime.datetime.now()}] 实时监控线程停止")


def start_real_time_monitor():
    """启动实时监控（保证同一时刻只有一个监控线程）。

    监控线程每轮重读 realTimeMonitoring 配置，故配置变更（间隔、监测项、通知等）
    无需重启线程，下一轮即生效。据此避免「每次保存配置都 stop+restart」导致的
    并发多线程问题（旧线程周期长、join 超时后新线程并发启动）：
    - 线程正常运行 + 启用：复用，不重启；
    - 线程正常运行 + 禁用：通知退出；
    - 线程正在退出 + 启用：等其退出后启动新线程；
    - 无线程 + 启用：启动新线程。
    """
    global real_time_monitor_thread, real_time_monitor_running, _realtime_stop_event
    REAL_TIME_MONITORING = get_config('realTimeMonitoring')
    enabled = REAL_TIME_MONITORING.get('enabled', False)

    print(f"[{datetime.datetime.now()}] 实时监控调度（enabled={enabled}）")

    thread_alive = bool(real_time_monitor_thread and real_time_monitor_thread.is_alive())
    # stop_event 已 set 表示线程正在退出（刚被禁用或停止）
    stopping = _realtime_stop_event is not None and _realtime_stop_event.is_set()

    if thread_alive and not stopping:
        if enabled:
            # 监控线程运行中，每轮重读配置，配置变更下一轮即生效，复用避免并发
            print(f"[{datetime.datetime.now()}] 实时监控线程运行中，复用（配置下一轮生效）")
            return
        # 禁用：通知线程退出（线程在下个 stop_event 检查点退出）
        _realtime_stop_event.set()
        real_time_monitor_running = False
        print(f"[{datetime.datetime.now()}] 实时监控已禁用，通知线程退出")
        return

    # 线程正在退出（禁用后重启等场景）：等待其真正退出，避免与新线程并发
    if thread_alive and stopping:
        print(f"[{datetime.datetime.now()}] 等待旧实时监控线程退出...")
        real_time_monitor_thread.join(timeout=30)

    if enabled:
        _realtime_stop_event = threading.Event()
        real_time_monitor_running = True
        real_time_monitor_thread = threading.Thread(
            target=real_time_monitor, args=(_realtime_stop_event,), daemon=True
        )
        real_time_monitor_thread.start()
        print(f"[{datetime.datetime.now()}] 实时监控线程已启动")
    else:
        _realtime_stop_event = None
        real_time_monitor_running = False
        print(f"[{datetime.datetime.now()}] 实时监控已禁用")


def stop_real_time_monitor():
    """停止实时监控"""
    global real_time_monitor_running, _realtime_stop_event
    print(f"[{datetime.datetime.now()}] 停止实时监控")
    if _realtime_stop_event is not None:
        _realtime_stop_event.set()
    real_time_monitor_running = False


def start_scheduler():
    """启动定时任务"""
    global scheduler

    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger

    SCHEDULER_CONFIG = get_config('scheduler')
    DAILY_INSPECTION_CONFIG = get_config('dailyInspection')

    print(f"[{datetime.datetime.now()}] ========== 开始启动定时任务 ==========")

    if scheduler:
        try:
            scheduler.shutdown(wait=True)
        except Exception as e:
            print(f"关闭scheduler时出错: {e}")
        finally:
            scheduler = None

    scheduler = BackgroundScheduler()

    if SCHEDULER_CONFIG.get("enabled", False):
        cron = SCHEDULER_CONFIG.get("cron", "0 0 * * *")
        parts = cron.split()
        if len(parts) == 5:
            minute, hour, day, month, weekday = parts
            scheduler.add_job(
                run_scheduled_inspection,
                CronTrigger(minute=minute, hour=hour, day=day, month=month, day_of_week=weekday),
                id='scheduled_inspection', replace_existing=True
            )

    if DAILY_INSPECTION_CONFIG.get("enabled", False):
        hour = DAILY_INSPECTION_CONFIG.get("hour", 9)
        minute = DAILY_INSPECTION_CONFIG.get("minute", 0)
        scheduler.add_job(
            run_daily_inspection,
            CronTrigger(minute=minute, hour=hour),
            id='daily_inspection', replace_existing=True
        )

    if scheduler.get_jobs():
        scheduler.start()
        print(f"[{datetime.datetime.now()}] ========== 定时任务已成功启动 ==========")
    else:
        print(f"[{datetime.datetime.now()}] 没有注册任何定时任务")

    start_real_time_monitor()