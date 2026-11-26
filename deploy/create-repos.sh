#!/bin/bash
# 在 Gitea 上确保 qubius 仓库存在（两个实例共用这一个仓库）。
# 默认 dry-run，只打印计划；--apply 才调用 Gitea API。
# 幂等：先查询，已存在则跳过；不会 push 任何代码。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "$HERE/lib.sh"

usage() {
  cat <<'EOF'
用法：deploy/create-repos.sh [--apply]

确保 Gitea 上存在 qubius 仓库（主、副两个实例共用这一个仓库）。
默认 dry-run，只打印计划；加 --apply 才调用 Gitea API。
已存在的仓库会跳过，脚本不 push 任何代码。

选项：
  --apply       创建缺失的仓库（幂等）
  -h, --help    显示本帮助

环境变量（可写在 ~/.config/qubius/env 或 <checkout>/deploy/env）：
  QUBIUS_GITEA_URL     Gitea 根地址，默认 http://gitea.example.com
  QUBIUS_GITEA_OWNER   仓库所属用户或组织，默认 example
  QUBIUS_GITEA_TOKEN   API token，仅 --apply 需要；只从环境读取，不会打印

owner 必须真实存在。若 owner 是用户，token 必须属于该用户本人才能创建；
若 owner 是组织，token 需要该组织的建库权限。脚本不会猜测，也不会把仓库
建到 token 所属用户名下。

仓库创建后，请在各 checkout 设置 origin 并首次推送（脚本不会代做）。
两个 checkout 都指向同一个仓库：

  git -C "$QUBIUS_PRIMARY_DIR"   remote add origin "$QUBIUS_PRIMARY_REPO_URL"
  git -C "$QUBIUS_PRIMARY_DIR"   push -u origin main
  git -C "$QUBIUS_SECONDARY_DIR" remote add origin "$QUBIUS_SECONDARY_REPO_URL"
  git -C "$QUBIUS_SECONDARY_DIR" push -u origin main

已有 origin 时，把 remote add 换成 remote set-url origin <url>。
EOF
}

APPLY=0
for arg in "$@"; do
  case $arg in
    --apply) APPLY=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) qubius_die "未知参数：$arg（用 --help 查看用法）" ;;
  esac
done

qubius_load

GITEA_URL=${QUBIUS_GITEA_URL%/}
OWNER=$QUBIUS_GITEA_OWNER
[[ -n $GITEA_URL ]] || qubius_die "QUBIUS_GITEA_URL 不能为空"
[[ $GITEA_URL =~ ^https?://[^[:space:]]+$ ]] \
  || qubius_die "QUBIUS_GITEA_URL 必须以 http:// 或 https:// 开头：$GITEA_URL"
[[ $OWNER =~ ^[A-Za-z0-9._-]+$ ]] \
  || qubius_die "QUBIUS_GITEA_OWNER 非法：$OWNER"

REPOS=(qubius)
REPO_URL_VARS=(QUBIUS_PRIMARY_REPO_URL)

# 打印 URL 时抹掉可能存在的 user:password@ 部分。
qubius_redact_url() {
  local url=$1
  if [[ $url =~ ^(https?://)[^/@]+@(.+)$ ]]; then
    printf '%s***@%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
  else
    printf '%s' "$url"
  fi
}

if ((APPLY == 0)); then
  qubius_info "create-repos：dry-run，不会调用 Gitea API"
  qubius_info "  Gitea：$GITEA_URL"
  qubius_info "  owner：$OWNER"
  qubius_info "  将要确保存在（已存在则跳过，默认私有）："
  for i in "${!REPOS[@]}"; do
    repo=${REPOS[$i]}
    var=${REPO_URL_VARS[$i]}
    qubius_info "    - $repo（本地对应 $var=$(qubius_redact_url "${!var}")）"
    qubius_info "      GET /api/v1/repos/$OWNER/$repo"
  done
  qubius_info "加 --apply 执行创建。脚本不会 push 任何代码。"
  exit 0
fi

[[ -n ${QUBIUS_GITEA_TOKEN:-} ]] \
  || qubius_die "缺少 QUBIUS_GITEA_TOKEN（仅 --apply 需要）；请从环境或 env 文件提供，不要写进提交文件"
qubius_require_cmd curl

# 错误信息脱敏：token 只可能出现在 HTTP 响应/curl 输出里，这里统一抹掉。
qubius_redact() {
  local text
  text=$(cat) || true
  if [[ -n ${QUBIUS_GITEA_TOKEN:-} ]]; then
    text=${text//"$QUBIUS_GITEA_TOKEN"/[redacted]}
  fi
  printf '%s' "$text"
}

# curl -K 配置里的带引号字符串需要转义反斜杠、引号和常见控制字符。
qubius_curl_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# 认证头通过 stdin 的 curl 配置传入，不出现在 curl 的 argv 里；
# curl 子进程也不再继承 QUBIUS_GITEA_TOKEN。
qubius_curl_auth() {
  local escaped
  escaped=$(qubius_curl_escape "$QUBIUS_GITEA_TOKEN")
  (
    unset QUBIUS_GITEA_TOKEN
    printf 'header = "Authorization: token %s"\n' "$escaped"
  ) | env -u QUBIUS_GITEA_TOKEN curl -sS --fail-with-body -K - "$@"
}

# 只取 HTTP 状态码；--fail-with-body 会让 4xx/5xx 返回非零，状态码仍会写出。
qubius_api_status() {
  local method=$1 path=$2 status rc=0
  status=$(qubius_curl_auth --connect-timeout 10 --max-time 60 \
    -o /dev/null -w '%{http_code}' \
    -X "$method" \
    -H "Accept: application/json" \
    "$GITEA_URL$path" 2>/dev/null) || rc=$?
  printf '%s' "${status:-000}"
}

# GET 并保留响应体，结果放进 API_STATUS / API_RC / API_BODY / API_OUT（已脱敏）。
API_STATUS=000
API_RC=0
API_BODY=
API_OUT=
qubius_api_fetch() {
  local path=$1 resp err status rc=0
  resp=$(mktemp)
  err=$(mktemp)
  status=$(qubius_curl_auth --connect-timeout 10 --max-time 60 \
    -o "$resp" -w '%{http_code}' \
    -X GET \
    -H "Accept: application/json" \
    "$GITEA_URL$path" 2>"$err") || rc=$?
  API_STATUS=${status:-000}
  API_RC=$rc
  API_BODY=$(cat "$resp" 2>/dev/null || true)
  API_OUT=$({ cat "$err" 2>/dev/null || true; } | qubius_redact)
  rm -f "$resp" "$err"
}

# 调用创建接口，结果放进 API_STATUS / API_RC / API_OUT（已脱敏）。
qubius_api_create() {
  local path=$1 repo=$2 resp err status rc=0
  resp=$(mktemp)
  err=$(mktemp)
  status=$(qubius_curl_auth --connect-timeout 10 --max-time 60 \
    -o "$resp" -w '%{http_code}' \
    -X POST \
    -H "Accept: application/json" \
    -H "Content-Type: application/json" \
    --data-binary "{\"name\":\"$repo\",\"private\":true}" \
    "$GITEA_URL$path" 2>"$err") || rc=$?
  API_STATUS=${status:-000}
  API_RC=$rc
  API_OUT=$(
    {
      cat "$err" 2>/dev/null || true
      if [[ -s $resp ]]; then
        printf '\n'
        cat "$resp"
      fi
    } | qubius_redact
  )
  rm -f "$resp" "$err"
}

qubius_verify_repo() {
  local repo=$1 status
  status=$(qubius_api_status GET "/api/v1/repos/$OWNER/$repo")
  [[ $status == 200 ]] \
    || qubius_die "创建 $repo 后校验失败：GET /api/v1/repos/$OWNER/$repo 返回 HTTP $status，无法确认仓库落在 $OWNER 名下"
}

# ── owner 校验：必须真实存在；用户型 owner 必须和 token 用户一致 ─────────────
ORG_STATUS=$(qubius_api_status GET "/api/v1/orgs/$OWNER")
USER_STATUS=$(qubius_api_status GET "/api/v1/users/$OWNER")

if [[ $ORG_STATUS == 401 || $ORG_STATUS == 403 || $USER_STATUS == 401 || $USER_STATUS == 403 ]]; then
  qubius_die "查询 owner 认证失败（org HTTP $ORG_STATUS，user HTTP $USER_STATUS）；请检查 QUBIUS_GITEA_TOKEN 的权限"
fi
if [[ $ORG_STATUS == 000 || $USER_STATUS == 000 ]]; then
  qubius_die "无法连接 $GITEA_URL（org HTTP $ORG_STATUS，user HTTP $USER_STATUS）"
fi

if [[ $ORG_STATUS == 200 ]]; then
  OWNER_TYPE=org
  CREATE_PATH="/api/v1/orgs/$OWNER/repos"
elif [[ $USER_STATUS == 200 ]]; then
  OWNER_TYPE=user
  qubius_api_fetch "/api/v1/user"
  [[ $API_STATUS == 200 ]] \
    || qubius_die "读取 token 所属用户失败（HTTP $API_STATUS）：$API_OUT"
  LOGIN=$(printf '%s' "$API_BODY" \
    | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)
  [[ -n $LOGIN ]] \
    || qubius_die "无法从 /api/v1/user 的响应解析 login；请检查 QUBIUS_GITEA_TOKEN 或 Gitea 版本"
  if [[ $LOGIN != "$OWNER" ]]; then
    qubius_die "QUBIUS_GITEA_OWNER=$OWNER 是用户，但当前 token 属于 $LOGIN。/api/v1/user/repos 会建到 token 用户 $LOGIN 名下，可能建错账号；请改用 $OWNER 本人的 token，或把 owner 改成组织。"
  fi
  CREATE_PATH="/api/v1/user/repos"
elif [[ $ORG_STATUS == 404 && $USER_STATUS == 404 ]]; then
  qubius_die "QUBIUS_GITEA_OWNER=$OWNER 既不是已存在的组织也不是已存在的用户；请修正 owner 后重试（如果 owner 确实存在，可能是 token 无权查看）"
else
  qubius_die "查询 owner 失败（org HTTP $ORG_STATUS，user HTTP $USER_STATUS）；请检查 Gitea 地址和 token"
fi

qubius_info "owner：$OWNER（$OWNER_TYPE），创建接口：$CREATE_PATH"

for repo in "${REPOS[@]}"; do
  status=$(qubius_api_status GET "/api/v1/repos/$OWNER/$repo")
  case $status in
    200)
      qubius_info "$repo：已存在，跳过"
      continue
      ;;
    404) ;;
    401 | 403)
      qubius_die "$repo：认证失败（HTTP $status），请检查 QUBIUS_GITEA_TOKEN 及权限"
      ;;
    000)
      qubius_die "$repo：无法连接 $GITEA_URL"
      ;;
    *)
      qubius_die "$repo：查询失败（HTTP $status）"
      ;;
  esac

  qubius_api_create "$CREATE_PATH" "$repo"
  case $API_STATUS in
    200 | 201)
      qubius_verify_repo "$repo"
      qubius_info "$repo：已创建（默认私有，已确认落在 $OWNER 名下）"
      ;;
    409 | 422)
      # 409 通常表示已存在；422 也可能是并发创建。重新查询目标仓库确认落点。
      status=$(qubius_api_status GET "/api/v1/repos/$OWNER/$repo")
      if [[ $status == 200 ]]; then
        qubius_info "$repo：已存在，跳过（创建请求返回 HTTP $API_STATUS，已确认目标仓库存在）"
      elif [[ $API_STATUS == 422 ]]; then
        qubius_die "创建 $repo 失败（HTTP 422）：$API_OUT"
      else
        qubius_die "创建 $repo 返回 HTTP 409，但 GET /api/v1/repos/$OWNER/$repo 返回 HTTP $status；请检查 owner 和仓库名"
      fi
      ;;
    401 | 403)
      qubius_die "创建 $repo 认证失败（HTTP $API_STATUS）：$API_OUT"
      ;;
    000)
      qubius_die "创建 $repo 时无法连接 $GITEA_URL"
      ;;
    *)
      qubius_die "创建 $repo 返回意外状态 HTTP $API_STATUS：$API_OUT"
      ;;
  esac
done

qubius_info ""
qubius_info "完成。脚本没有 push 任何代码。接下来在每个 checkout 设置 origin 并首次推送："
qubius_info "  git -C \"$QUBIUS_PRIMARY_DIR\" remote add origin \"$(qubius_redact_url "$QUBIUS_PRIMARY_REPO_URL")\""
qubius_info "  git -C \"$QUBIUS_PRIMARY_DIR\" push -u origin main"
qubius_info "  git -C \"$QUBIUS_SECONDARY_DIR\" remote add origin \"$(qubius_redact_url "$QUBIUS_SECONDARY_REPO_URL")\""
qubius_info "  git -C \"$QUBIUS_SECONDARY_DIR\" push -u origin main"
qubius_info "已有 origin 时，用 git remote set-url origin <url> 替换；URL 里若含凭据，上面已脱敏，请使用 env 中的实际值。"
