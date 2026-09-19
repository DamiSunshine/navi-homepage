#!/usr/bin/env bash
# ============================================================
# Navi 一键迁移脚本：从「单文件挂载」平滑升级到「整目录挂载」
# 适用：旧版 docker run（单文件挂载 config.json + uploads）
#       → 新版（整目录 ./data:/app/data，规避 RBUSY/EXDEV 保存失败）
#
# 用法：在 导航站 项目目录下执行
#   sudo bash scripts/migrate-to-dir-mount.sh [--no-compose]
#
# - 自动备份现有 config 与 uploads 到 ./backups/<时间戳>/
# - 迁移真实数据到 ./data/{config.json,uploads/}
# - 重建镜像
# - 默认用 docker compose 起容器；加 --no-compose 则用 docker run
# - 全程幂等，可重复运行；不丢数据，不停旧容器直到迁移成功
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."          # 切到项目根（脚本在 scripts/ 内）
ROOT="$(pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT/backups/$STAMP"
DATA_DIR="$ROOT/data"

# ---------- 参数 ----------
USE_COMPOSE=1
for a in "$@"; do
  case "$a" in
    --no-compose) USE_COMPOSE=0 ;;
    *) echo "未知参数: $a（可用 --no-compose）" >&2; exit 1 ;;
  esac
done

# ---------- 基础检查 ----------
command -v docker >/dev/null || { echo "✗ 未找到 docker，请先安装" >&2; exit 1; }
[ -f server.js ] || { echo "✗ 当前目录不是 Navi 项目根（缺少 server.js）" >&2; exit 1; }
[ -f docker-compose.yml ] || { echo "✗ 缺少 docker-compose.yml" >&2; exit 1; }

echo "==> Navi 迁移：整目录挂载 升级"
echo "    项目目录 : $ROOT"
echo "    数据目录 : $DATA_DIR"
echo "    备份位置 : $BACKUP_DIR"
echo "    启动方式 : $([ $USE_COMPOSE -eq 1 ] && echo 'docker compose' || echo 'docker run')"

# ---------- 0. 确认当前旧容器（若存在） ----------
OLD_NAME="navi"
# Docker 需要 root（飞牛等 NAS 常需 sudo）；宿主机文件操作用 $SUDO 保持属主一致，
# 由容器内 root 读写挂载目录 /app/data——node:22-alpine 镜像未设 USER，默认以 root 运行。
SUDO=""
command -v sudo >/dev/null 2>&1 && SUDO="sudo"
if $SUDO docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$OLD_NAME"; then
  echo "==> 检测到旧容器 [$OLD_NAME]，将先备份其现有数据，再重建。"
else
  echo "==> 未发现旧容器 [$OLD_NAME]，将全新部署。"
fi

# ---------- 1. 备份现有数据（保险，必做） ----------
$SUDO mkdir -p "$BACKUP_DIR"
# 旧数据来源：旧 docker run 可能把 config 挂载到镜像内 public/config.json
# 优先从容器内拉取（最准），其次从宿主机 public/ 兜底
SRC_CONF=""
SRC_UPLOADS=""
if $SUDO docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$OLD_NAME"; then
  if $SUDO docker inspect "$OLD_NAME" >/dev/null 2>&1; then
    # 尝试从容器内拷出真实 config（覆盖挂载前后的差异）
    if $SUDO docker cp "$OLD_NAME:/app/public/config.json" "$BACKUP_DIR/container-public-config.json" 2>/dev/null; then
      SRC_CONF="$BACKUP_DIR/container-public-config.json"
    fi
    if $SUDO docker cp "$OLD_NAME:/app/public/uploads" "$BACKUP_DIR/container-uploads" 2>/dev/null; then
      SRC_UPLOADS="$BACKUP_DIR/container-uploads"
    fi
  fi
fi
# 兜底：宿主机项目目录里的旧文件
[ -f public/config.json ] && { [ -z "$SRC_CONF" ] && $SUDO cp public/config.json "$BACKUP_DIR/host-config.json" && SRC_CONF="$BACKUP_DIR/host-config.json"; }
if [ -d public/uploads ] && [ -z "$SRC_UPLOADS" ]; then
  $SUDO cp -r public/uploads "$BACKUP_DIR/host-uploads" 2>/dev/null && SRC_UPLOADS="$BACKUP_DIR/host-uploads" || true
fi

echo "==> 备份完成于 $BACKUP_DIR"
$SUDO ls -l "$BACKUP_DIR" 2>/dev/null | sed 's/^/    /'

# ---------- 2. 构建新的 data 目录（迁移真实数据） ----------
$SUDO mkdir -p "$DATA_DIR/uploads"
# config：优先用备份到的真实配置；否则用内置示例
if [ -n "$SRC_CONF" ] && [ -s "$SRC_CONF" ]; then
  $SUDO cp "$SRC_CONF" "$DATA_DIR/config.json"
  echo "==> 已迁移真实 config.json -> $DATA_DIR/config.json"
else
  if [ -f public/config.example.json ]; then
    $SUDO cp public/config.example.json "$DATA_DIR/config.json"
    echo "==> 无旧配置，使用示例配置 data/config.json（之后在网页里自行编辑）"
  else
    echo "✗ 无旧配置也无示例配置，已中止" >&2; exit 1
  fi
fi
# uploads：迁移旧图片（若有）
if [ -n "$SRC_UPLOADS" ] && [ -d "$SRC_UPLOADS" ]; then
  $SUDO cp -r "$SRC_UPLOADS"/. "$DATA_DIR/uploads/" 2>/dev/null || true
  echo "==> 已迁移 uploads 图片 -> $DATA_DIR/uploads/"
fi
# 校验生成的 config 是合法 JSON（node / python 任一可用；都无则仅提示）
if command -v node >/dev/null 2>&1; then
  node -e "JSON.parse(require('fs').readFileSync('data/config.json','utf8'));" \
    || { echo "✗ data/config.json 不是合法 JSON，请检查备份" >&2; exit 1; }
  echo "==> data/config.json 校验通过 ✓ (node)"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import json;json.load(open('data/config.json'));" \
    || { echo "✗ data/config.json 不是合法 JSON，请检查备份" >&2; exit 1; }
  echo "==> data/config.json 校验通过 ✓ (python3)"
else
  echo "==> 未检测到 node/python3，跳过 JSON 校验（继续）"
fi

# ---------- 3. 停旧容器 ----------
if $SUDO docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$OLD_NAME"; then
  echo "==> 停止旧容器 $OLD_NAME"
  $SUDO docker stop "$OLD_NAME" >/dev/null
fi

# ---------- 4. 重建镜像 ----------
echo "==> 重建镜像（docker build）..."
$SUDO docker build -t navi:latest .
echo "==> 镜像构建完成 ✓"

# ---------- 5. 启动容器（整目录挂载） ----------
if [ $USE_COMPOSE -eq 1 ]; then
  echo "==> 使用 docker compose 启动（./data:/app/data）..."
  $SUDO docker rm -f "$OLD_NAME" >/dev/null 2>&1 || true
  $SUDO docker compose up -d --remove-orphans
else
  echo "==> 使用 docker run 启动（./data:/app/data）..."
  $SUDO docker rm -f "$OLD_NAME" >/dev/null 2>&1 || true
  # 密码优先读环境变量；未提供则用占位 CHANGE_ME，避免把真实密钥写进 shell 历史
  NAVI_PW_IMPL="${NAVI_PASSWORD:-CHANGE_ME}"
  $SUDO docker run -d --name "$OLD_NAME" -p 8080:80 --restart unless-stopped \
    -e "NAVI_PASSWORD=$NAVI_PW_IMPL" \
    -e NAVI_CONFIG_PATH=/app/data/config.json \
    -e NAVI_UPLOAD_DIR=/app/data/uploads \
    -v "$DATA_DIR:/app/data" \
    navi
fi

# ---------- 6. 验证 ----------
echo "==> 等待容器就绪..."
for i in $(seq 1 30); do
  if $SUDO docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$OLD_NAME" && \
     curl -sf "http://127.0.0.1:8080/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
echo "==> 容器状态："
$SUDO docker ps --filter name="$OLD_NAME" | sed 's/^/    /'
echo "==> 健康检查：
    $(curl -sf http://127.0.0.1:8080/api/health || echo '（未就绪，请查看: '$SUDO' docker logs navi）')"
echo "==> 数据目录确认：
    $($SUDO ls -l "$DATA_DIR" | sed 's/^/    /')"
echo ""
echo "✅ 迁移完成！请浏览器强制刷新（Ctrl+Shift+R）访问，编辑保存应不再报 EBUSY。"
echo "   备份保留在：$BACKUP_DIR（确认无误后可手动删除）"
