"""
调度模块 - 路由定义
"""

from flask import Blueprint, jsonify
import datetime
import threading
import time

from modules.auth.helpers import login_required
from modules.config_mgmt.helpers import get_config, notification_cooldowns
from modules.inspection.helpers import get_inspection_functions
from modules.custom_scripts.helpers import run_custom_scripts
from dingtalk import dingtalk_notifier

scheduler_bp = Blueprint('scheduler', __name__, url_prefix='/api/scheduler')

# 全局scheduler变量
scheduler = None

# 全局实时监控线程变量
real_time_monitor_thread = None
real_time_monitor_running = False


@scheduler_bp.route('/status', methods=['GET'])
@login_required
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
def run_daily_now():
    """立即执行一次日常巡检"""
    try:
        thread = threading.Thread(target=run_daily_inspection)
        thread.start()
        return jsonify({'message': '日常巡检已启动'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def run_scheduled_inspection():
    """执行定时巡检"""
    print(f"[{datetime.datetime.now()}] 开始执行定时巡检...")
    SCHEDULED_INSPECTION_ITEMS = get_config('scheduledInspectionItems')
    DINGTALK_CONFIG = get_config('dingtalk')

    try:
        results = {}
        for item, enabled in SCHEDULED_INSPECTION_ITEMS.items():
            if enabled and item in get_inspection_functions():
                result = get_inspection_functions()[item]()
                results[item] = result.to_dict()

        custom_results = run_custom_scripts('scheduled')
        results.update(custom_results)

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


def run_daily_inspection():
    """执行日常巡检"""
    print(f"[{datetime.datetime.now()}] 开始执行日常巡检...")
    DAILY_INSPECTION_ITEMS = get_config('dailyInspectionItems')
    DINGTALK_CONFIG = get_config('dingtalk')

    try:
        results = {}
        for item, enabled in DAILY_INSPECTION_ITEMS.items():
            if enabled and item in get_inspection_functions():
                result = get_inspection_functions()[item]()
                results[item] = result.to_dict()

        custom_results = run_custom_scripts('daily')
        results.update(custom_results)

        print(f"[{datetime.datetime.now()}] 日常巡检完成，发送通知...")
        if DINGTALK_CONFIG.get('enabled', False):
            dingtalk_notifier.send_inspection_report(results, "daily")

        print(f"[{datetime.datetime.now()}] 日常巡检完成")
    except Exception as e:
        print(f"[{datetime.datetime.now()}] 日常巡检出错: {e}")
        import traceback
        traceback.print_exc()


def real_time_monitor():
    """实时监控线程"""
    global real_time_monitor_running
    print(f"[{datetime.datetime.now()}] 实时监控线程启动")

    while real_time_monitor_running:
        try:
            REAL_TIME_MONITORING = get_config('realTimeMonitoring')
            if not REAL_TIME_MONITORING.get('enabled', False):
                print(f"[{datetime.datetime.now()}] 实时监控已禁用，线程准备退出")
                real_time_monitor_running = False
                break

            interval = REAL_TIME_MONITORING.get('interval', 10)
            items = REAL_TIME_MONITORING.get('items', {})
            notification_config = REAL_TIME_MONITORING.get('notification', {})
            notification_enabled = notification_config.get('enabled', False)
            alert_levels = notification_config.get('alert_levels', ['warning', 'critical'])
            dingtalk_enabled = notification_config.get('dingtalk', False)
            cooldown_period = notification_config.get('cooldown_period', 300)

            if not notification_enabled:
                time.sleep(interval)
                continue

            results = {}
            for item, enabled in items.items():
                if enabled and item in get_inspection_functions():
                    result = get_inspection_functions()[item]()
                    results[item] = result.to_dict()

            custom_results = run_custom_scripts('realtime')
            results.update(custom_results)

            if not notification_enabled:
                time.sleep(interval)
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
                current_time = time.time()
                last_notification = notification_cooldowns.get('real_time', 0)
                if current_time - last_notification > cooldown_period:
                    print(f"[{datetime.datetime.now()}] 实时监控发现异常，发送通知")
                    DINGTALK_CONFIG = get_config('dingtalk')
                    if dingtalk_enabled and DINGTALK_CONFIG.get('enabled', False):
                        dingtalk_notifier.send_inspection_report(alert_results, "real_time")
                    notification_cooldowns['real_time'] = current_time

            time.sleep(interval)
        except Exception as e:
            print(f"[{datetime.datetime.now()}] 实时监控线程出错: {e}")
            import traceback
            traceback.print_exc()
            time.sleep(10)

    print(f"[{datetime.datetime.now()}] 实时监控线程停止")


def start_real_time_monitor():
    """启动实时监控"""
    global real_time_monitor_thread, real_time_monitor_running
    REAL_TIME_MONITORING = get_config('realTimeMonitoring')

    print(f"[{datetime.datetime.now()}] 开始启动实时监控")
    print(f"[{datetime.datetime.now()}] 实时监控配置: {REAL_TIME_MONITORING}")

    if real_time_monitor_thread and real_time_monitor_thread.is_alive():
        print(f"[{datetime.datetime.now()}] 停止现有的实时监控线程")
        real_time_monitor_running = False
        time.sleep(0.5)

    if REAL_TIME_MONITORING.get('enabled', False):
        real_time_monitor_running = True
        real_time_monitor_thread = threading.Thread(target=real_time_monitor, daemon=True)
        real_time_monitor_thread.start()
        print(f"[{datetime.datetime.now()}] 实时监控线程已启动")
    else:
        print(f"[{datetime.datetime.now()}] 实时监控已禁用，不启动线程")
        real_time_monitor_running = False


def stop_real_time_monitor():
    """停止实时监控"""
    global real_time_monitor_running
    print(f"[{datetime.datetime.now()}] 停止实时监控")
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