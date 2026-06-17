import datetime

class InspectionResult:
    def __init__(self):
        self.info = []
        self.warnings = []
        self.criticals = []
        self.normals = []
        self.slow_sqls = []
        self.start_time = datetime.datetime.now()
        self.end_time = None

    def add_info(self, message):
        self.info.append(message)

    def add_warning(self, message):
        self.warnings.append(message)

    def add_critical(self, message):
        self.criticals.append(message)

    def add_normal(self, message):
        self.normals.append(message)

    def add_slow_sql(self, message):
        self.slow_sqls.append(message)

    def set_end_time(self):
        self.end_time = datetime.datetime.now()

    def to_dict(self):
        return {
            'info': self.info,
            'warnings': self.warnings,
            'criticals': self.criticals,
            'normals': self.normals,
            'slow_sqls': self.slow_sqls,
            'start_time': self.start_time.strftime('%Y-%m-%d %H:%M:%S'),
            'end_time': self.end_time.strftime('%Y-%m-%d %H:%M:%S') if self.end_time else None,
            'duration': str(self.end_time - self.start_time) if self.end_time else None
        }