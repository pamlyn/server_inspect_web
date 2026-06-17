"""
Arthas 一键诊断预设命令定义
每个预设包含一个诊断分类及其下的命令列表
"""

from typing import List, Dict

PRESETS = {
    "thread_analysis": {
        "name": "线程分析",
        "icon": "fa-sort-amount-desc",
        "description": "分析线程状态，找出死锁和最繁忙的线程",
        "commands": [
            {"command": "thread", "label": "线程概览", "desc": "查看所有线程状态"},
            {"command": "thread -n 3", "label": "TOP 3繁忙线程", "desc": "找出CPU占用最高的3个线程"},
            {"command": "thread -b", "label": "死锁检测", "desc": "检测是否有线程死锁"},
        ]
    },
    "memory_analysis": {
        "name": "内存分析",
        "icon": "fa-braille",
        "description": "分析JVM内存使用情况",
        "commands": [
            {"command": "memory", "label": "内存概览", "desc": "查看各内存区域使用情况"},
            {"command": "dashboard", "label": "实时面板", "desc": "实时查看线程/内存/GC信息（异步命令）"},
        ]
    },
    "class_inspection": {
        "name": "类/方法排查",
        "icon": "fa-search",
        "description": "搜索类、反编译代码、查看方法详情",
        "commands": [
            {"command": "sc *Controller", "label": "搜索Controller类", "desc": "查找所有Controller类"},
            {"command": "sc -d *Application", "label": "类详细信息", "desc": "查看类的完整信息（类加载器、来源等）"},
        ]
    },
    "method_observation": {
        "name": "方法观测",
        "icon": "fa-eye",
        "description": "观测方法执行参数、返回值、异常",
        "commands": [
            {"command": "watch {classPattern} {methodPattern} '{params}'", "label": "观测方法参数", "desc": "观察方法的入参和返回值", "is_template": True, "template_vars": ["classPattern", "methodPattern", "params"]},
            {"command": "trace {classPattern} {methodPattern}", "label": "调用链路追踪", "desc": "追踪方法内部调用链路及耗时", "is_template": True, "template_vars": ["classPattern", "methodPattern"]},
            {"command": "stack {classPattern} {methodPattern}", "label": "调用栈", "desc": "查看方法被调用的完整栈路径", "is_template": True, "template_vars": ["classPattern", "methodPattern"]},
        ]
    },
    "performance": {
        "name": "性能诊断",
        "icon": "fa-tachometer",
        "description": "生成火焰图、性能采样",
        "commands": [
            {"command": "profiler start", "label": "开始性能采样", "desc": "启动async-profiler采样"},
            {"command": "profiler status", "label": "采样状态", "desc": "查看当前采样状态"},
            {"command": "profiler stop --format html", "label": "生成火焰图", "desc": "停止采样并生成HTML火焰图"},
        ]
    },
    "runtime_config": {
        "name": "运行时配置",
        "icon": "fa-cog",
        "description": "查看和修改JVM运行时配置",
        "commands": [
            {"command": "vmoption", "label": "JVM选项", "desc": "查看所有JVM选项"},
            {"command": "logger", "label": "日志级别", "desc": "查看日志配置"},
        ]
    }
}


def get_all_presets() -> Dict:
    """返回所有预设分类及其命令"""
    return PRESETS


def get_preset_commands(preset_id: str) -> List[Dict]:
    """返回特定预设的命令列表"""
    preset = PRESETS.get(preset_id)
    if not preset:
        return []
    return preset.get('commands', [])