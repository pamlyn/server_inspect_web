# 服务器巡检Web应用

一个基于Flask的服务器巡检Web应用，可以通过Web界面实时监控服务器状态。

## 功能特点

- **完整巡检**：一键执行所有巡检项目
- **单独模块巡检**：可以选择只巡检系统信息、CPU、内存、磁盘、网络、进程或数据库
- **实时结果展示**：巡检结果实时显示在Web界面上，包括信息、警告和紧急情况
- **美观的界面**：使用Tailwind CSS设计，响应式布局，支持展开/折叠查看详细信息

## 部署方法

### 方法1：容器化部署（推荐）

#### 前提条件
- 已安装Docker
- 已安装Docker Compose（或使用Docker内置的compose子命令）

#### 步骤
1. 进入项目目录：
   ```bash
   cd server_inspect_web
   ```

2. 使用Docker Compose启动应用：
   ```bash
   # 对于新版本的Docker（使用内置的compose子命令）
   docker compose up -d
   
   # 对于旧版本的Docker（使用独立的docker-compose命令）
   docker-compose up -d
   ```

3. 访问应用：
   ```
   http://localhost:5001/
   ```

### 方法2：本地启动

#### 前提条件
- 已安装Python 3
- 已安装pip

#### 步骤
1. 进入项目目录：
   ```bash
   cd server_inspect_web
   ```

2. 运行一键启动脚本：
   ```bash
   ./start.sh
   ```

3. 访问应用：
   ```
   http://localhost:5001/
   ```

## 故障排除

### 1. docker-compose: command not found

**问题**：执行`docker-compose up -d`时提示命令未找到。

**解决方案**：
- 对于新版本的Docker，使用内置的compose子命令：
  ```bash
  docker compose up -d
  ```
- 或者安装Docker Compose：
  ```bash
  # Ubuntu/Debian
  sudo apt-get install docker-compose
  
  # CentOS/RHEL
  sudo yum install docker-compose
  
  # 或者使用pip安装
  pip install docker-compose
  ```

### 2. 网络问题导致无法拉取Docker镜像

**问题**：执行`docker compose up -d`时提示网络错误，无法拉取Python镜像。

**解决方案**：
- 检查网络连接是否正常
- 尝试使用本地启动方法：
  ```bash
  ./start.sh
  ```

### 3. 端口5001已被占用

**问题**：启动应用时提示端口5001已被占用。

**解决方案**：
- 修改`app.py`文件中的端口号：
  ```python
  if __name__ == '__main__':
      app.run(debug=True, host='0.0.0.0', port=5002)  # 修改为其他端口
  ```
- 或者修改`docker-compose.yml`文件中的端口映射：
  ```yaml
  ports:
    - "5002:5001"  # 修改为其他端口
  ```

### 4. 依赖安装失败

**问题**：执行`./start.sh`时依赖安装失败。

**解决方案**：
- 检查网络连接是否正常
- 尝试使用`--trusted-host`参数安装依赖：
  ```bash
  pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org -r requirements.txt
  ```

## 项目结构

```
server_inspect_web/
├── app.py          # 主应用文件，包含巡检逻辑
├── Dockerfile      # Docker镜像构建文件
├── docker-compose.yml  # Docker Compose配置文件
├── requirements.txt    # 依赖配置文件
├── start.sh        # 一键启动脚本
├── templates/      # 模板目录
│   └── index.html  # Web界面模板
└── README.md       # 项目说明文档
```

## 技术栈

- **后端**：Python 3, Flask
- **前端**：HTML5, Tailwind CSS, JavaScript
- **容器化**：Docker, Docker Compose

## 注意事项

- 容器化部署时，应用会自动重启（restart: always）
- 本地启动时，应用会在前台运行，按Ctrl+C停止
- 应用默认运行在5001端口
- 部分巡检功能需要root权限，容器化部署时已配置privileged: true
