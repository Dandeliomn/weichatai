#!/bin/sh
# 输出 HTTP 响应 + QR 码文本
printf 'HTTP/1.1 200 OK\r\n'
printf 'Content-Type: text/plain; charset=utf-8\r\n'
printf 'Connection: close\r\n'
printf '\r\n'
cat /tmp/qrcode.txt 2>/dev/null || echo "QR not ready"
