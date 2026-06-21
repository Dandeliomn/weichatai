#!/usr/bin/env python3
"""
聊天记录自动检测导入 + 防注入保护
用法:
  python3 chat_importer.py detect <text>          # 检测消息中是否包含聊天记录
  python3 chat_importer.py import <file_path>     # 导入聊天记录文件
  python3 chat_importer.py import-stdin           # 从stdin导入（用于管道）
"""
import os, sys, json, re, sqlite3, hashlib, zipfile, tempfile, shutil
from pathlib import Path
from datetime import datetime

HERMES_HOME = Path.home() / ".hermes"
CHAT_DB = HERMES_HOME / "memories" / "chat_history.db"
IMPORT_DIR = HERMES_HOME / "weixin" / "imports"
MAX_FILE_SIZE = 200 * 1024 * 1024  # 200MB
ALLOWED_EXTENSIONS = {'.html', '.htm', '.json', '.csv', '.txt', '.zip', '.gz', '.tgz', '.tar.gz'}

# ── 防注入 ──────────────────────────────────────────────
SQL_INJECTION_PATTERNS = [
    re.compile(r"(?:;|--|/\*|\\\*)\s*(?:DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|EXEC|UNION|TRUNCATE)\b", re.I),
    re.compile(r"(?:')\s*(?:OR|AND)\s+(?:'?\d+'?=|'[^']*'=)", re.I),
    re.compile(r"<script[^>]*>", re.I),
    re.compile(r"&#\d{2,};", re.I),
]

def is_safe_content(text: str) -> bool:
    """检查是否有注入风险"""
    for pattern in SQL_INJECTION_PATTERNS:
        if pattern.search(text):
            return False
    return True

def is_chat_record(text: str) -> bool:
    """检测文本是否像聊天记录"""
    patterns = [
        # WeChat format: "2024-01-01 12:00 用户名: 消息"
        re.compile(r'\d{4}[-/]\d{2}[-/]\d{2}\s+\d{1,2}:\d{2}'),
        # WeChat: "用户名 2024-01-01 12:00:00"
        re.compile(r'.{2,20}\s+\d{4}[-/]\d{2}[-/]\d{2}\s+\d{1,2}:\d{2}:\d{2}'),
        # QQ: "2024-01-01 12:00:00 用户名(QQ号)"
        re.compile(r'\d{4}[-/]\d{2}[-/]\d{2}\s+\d{1,2}:\d{2}:\d{2}\s+.+\(\d+\)'),
        # WeFlow JSON structure
        re.compile(r'"messages"\s*:\s*\[.*"sender"'),
    ]
    score = sum(1 for p in patterns if p.search(text[:10000]))
    return score >= 1

def detect_format(file_path: str) -> str:
    """检测文件格式"""
    ext = Path(file_path).suffix.lower()
    if ext in {'.zip', '.gz', '.tgz'} or file_path.endswith('.tar.gz'):
        return 'archive'

    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            head = f.read(1000).strip()

        if head.startswith('{') and '"messages"' in head:
            return 'weflow_json'
        if head.startswith('[') or (head.startswith('{') and 'sender' in head):
            return 'json'
        if '<!DOCTYPE html>' in head.lower() or '<html' in head.lower():
            return 'html'
        if is_chat_record(head):
            return 'txt_chat'
        return 'unknown'
    except:
        return 'unknown'

def import_file(file_path: str, persona_slug: str = None) -> dict:
    """导入聊天记录文件，返回统计信息"""
    file_path = os.path.abspath(file_path)
    fmt = detect_format(file_path)

    if fmt == 'unknown':
        return {"error": f"无法识别文件格式: {file_path}"}

    if fmt == 'archive':
        return import_archive(file_path, persona_slug)

    return import_parsed(file_path, fmt, persona_slug)

def import_archive(archive_path: str, persona_slug: str = None) -> dict:
    """解压并导入压缩包"""
    extract_dir = tempfile.mkdtemp(prefix='chat_import_')
    stats = {"files_found": 0, "imported": 0, "errors": []}

    try:
        if archive_path.endswith('.tar.gz'):
            import tarfile
            with tarfile.open(archive_path) as tf:
                tf.extractall(extract_dir)
        elif archive_path.endswith('.zip'):
            with zipfile.ZipFile(archive_path) as zf:
                # 安全检查：防止zip炸弹
                total_size = sum(info.file_size for info in zf.infolist())
                if total_size > MAX_FILE_SIZE:
                    return {"error": f"压缩包解压后超过 {MAX_FILE_SIZE // 1024 // 1024}MB 限制"}
                zf.extractall(extract_dir)
        else:
            import gzip, io
            with gzip.open(archive_path, 'rb') as gf:
                content = gf.read()
                if len(content) > MAX_FILE_SIZE:
                    return {"error": "解压后文件过大"}
                out_path = os.path.join(extract_dir, 'extracted')
                with open(out_path, 'wb') as out:
                    out.write(content)

        # 递归查找聊天文件
        for root, dirs, files in os.walk(extract_dir):
            for f in files:
                ext = Path(f).suffix.lower()
                if ext in ALLOWED_EXTENSIONS or f.endswith('.tar.gz'):
                    stats["files_found"] += 1
                    fp = os.path.join(root, f)
                    sub_fmt = detect_format(fp)
                    if sub_fmt not in ('unknown', 'archive'):
                        result = import_parsed(fp, sub_fmt, persona_slug)
                        if 'error' in result:
                            stats["errors"].append(f"{f}: {result['error']}")
                        else:
                            stats["imported"] += result.get("imported", 0)
    finally:
        shutil.rmtree(extract_dir, ignore_errors=True)

    return stats

def import_parsed(file_path: str, fmt: str, persona_slug: str = None) -> dict:
    """导入已解析的聊天记录"""
    messages = []

    try:
        if fmt == 'weflow_json':
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            for msg in data.get('messages', []):
                sender = str(msg.get('sender', '') or msg.get('from', '')).strip()
                content = str(msg.get('content', '') or msg.get('text', '')).strip()
                time_str = str(msg.get('time', '') or msg.get('timestamp', '')).strip()
                if sender and content and is_safe_content(content):
                    messages.append((sender, content, time_str))

        elif fmt == 'json':
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                for msg in data:
                    sender = str(msg.get('sender', '') or msg.get('from', '') or msg.get('name', '')).strip()
                    content = str(msg.get('content', '') or msg.get('text', '') or msg.get('message', '')).strip()
                    time_str = str(msg.get('time', '') or msg.get('timestamp', '') or msg.get('date', '')).strip()
                    if sender and content and is_safe_content(content):
                        messages.append((sender, content, time_str))

        elif fmt == 'html':
            from html.parser import HTMLParser
            class ChatParser(HTMLParser):
                def __init__(self):
                    super().__init__()
                    self.msgs = []
                    self._cur = {}
                def handle_data(self, data):
                    text = data.strip()
                    if text:
                        self._cur['text'] = text
            # Simplified HTML parsing - look for chat patterns
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                html = f.read()
            # Try to extract messages with regex
            msg_pattern = re.compile(r'(?:<div[^>]*>)?\s*([^\s<]{2,20})[:：]\s*(.+?)(?:</div>|$)', re.M)
            for m in msg_pattern.finditer(html):
                sender = m.group(1).strip()
                content = m.group(2).strip()
                if sender and content and is_safe_content(content):
                    messages.append((sender, content, ''))

        elif fmt == 'txt_chat':
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    # Try common WeChat formats
                    m = re.match(r'(\d{4}[-/]\d{2}[-/]\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.{2,20})[:：]\s*(.+)', line)
                    if m:
                        time_str, sender, content = m.groups()
                        if is_safe_content(content):
                            messages.append((sender.strip(), content.strip(), time_str))

        if not messages:
            return {"error": "未找到可识别的聊天消息"}

        # 去重
        seen = set()
        unique = []
        for s, c, t in messages:
            h = hashlib.md5(f"{s}|{c[:100]}".encode()).hexdigest()
            if h not in seen:
                seen.add(h)
                unique.append((s, c, t))

        # 写入数据库
        CHAT_DB.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(str(CHAT_DB))
        db.execute('''CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender TEXT, content TEXT, time TEXT, is_from_user INTEGER,
            source TEXT, imported_at TEXT
        )''')
        db.execute('CREATE INDEX IF NOT EXISTS idx_content ON messages(content)')

        now = datetime.now().isoformat()
        count = 0
        for s, c, t in unique:
            try:
                db.execute(
                    'INSERT INTO messages(sender, content, time, is_from_user, source, imported_at) VALUES(?,?,?,0,?,?)',
                    [s, c, t, f'importer:{fmt}', now]
                )
                count += 1
            except:
                pass

        db.commit()
        db.close()
        return {"imported": count, "duplicates_skipped": len(messages) - count}

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "detect"

    if cmd == "detect":
        text = sys.argv[2] if len(sys.argv) > 2 else sys.stdin.read()
        if is_chat_record(text):
            print("CHAT_RECORD_DETECTED")
        else:
            print("NOT_CHAT_RECORD")

    elif cmd == "import":
        if len(sys.argv) < 3:
            print("用法: chat_importer.py import <file_path>")
            sys.exit(1)
        result = import_file(sys.argv[2])
        print(json.dumps(result, ensure_ascii=False))

    elif cmd == "import-stdin":
        # Save stdin to temp file and import
        content = sys.stdin.buffer.read()
        if len(content) > MAX_FILE_SIZE:
            print(json.dumps({"error": "文件过大"}))
            sys.exit(1)
        suffix = '.txt'
        if content[:2] == b'PK': suffix = '.zip'
        elif content[:2] == b'\x1f\x8b': suffix = '.gz'
        elif content[:1] == b'{': suffix = '.json'
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        result = import_file(tmp_path)
        os.unlink(tmp_path)
        print(json.dumps(result, ensure_ascii=False))
