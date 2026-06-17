"""
认证模块 - 登录凭证、装饰器、验证码生成
"""

import random
import string
import threading
from PIL import Image, ImageDraw, ImageFont
from io import BytesIO
from flask import session, redirect, url_for

# 登录配置
LOGIN_CREDENTIALS = {
    'admin': 'Jack_59496'
}

# 密码错误计数存储
password_errors = {}

# 验证码存储
captcha_store = {}


def login_required(f):
    """登录要求装饰器"""
    def decorated_function(*args, **kwargs):
        if 'username' not in session:
            return redirect(url_for('auth.login'))
        return f(*args, **kwargs)
    decorated_function.__name__ = f.__name__
    return decorated_function


def generate_captcha():
    """生成验证码"""
    # 生成随机验证码
    captcha_text = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))

    # 创建验证码图片
    width, height = 120, 40
    image = Image.new('RGB', (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)

    # 生成随机干扰点
    for _ in range(100):
        x = random.randint(0, width - 1)
        y = random.randint(0, height - 1)
        draw.point((x, y), fill=(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)))

    # 生成随机干扰线
    for _ in range(5):
        x1 = random.randint(0, width - 1)
        y1 = random.randint(0, height - 1)
        x2 = random.randint(0, width - 1)
        y2 = random.randint(0, height - 1)
        draw.line((x1, y1, x2, y2), fill=(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)), width=1)

    # 绘制验证码文本
    try:
        # 尝试使用系统字体
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 24)
    except:
        # fallback to default font
        font = ImageFont.load_default()

    for i, char in enumerate(captcha_text):
        draw.text((30 + i * 20, 10), char, font=font, fill=(random.randint(0, 100), random.randint(0, 100), random.randint(0, 100)))

    # 保存验证码到内存
    buffer = BytesIO()
    image.save(buffer, format='PNG')
    buffer.seek(0)

    # 生成唯一标识符
    captcha_id = ''.join(random.choices(string.ascii_letters + string.digits, k=20))

    # 存储验证码
    captcha_store[captcha_id] = captcha_text

    # 设置验证码过期时间（5分钟）
    threading.Timer(300, lambda: captcha_store.pop(captcha_id, None)).start()

    return captcha_id, buffer