FROM cp0204/weclawbot-api:latest
# 安装 expect (提供 unbuffer, 为 bot CLI 提供伪终端以捕获来信)
RUN apk add --no-cache expect
COPY bridge-forward.sh /bridge-forward.sh
COPY qr-http-response.sh /qr-http-response.sh
RUN chmod +x /bridge-forward.sh /qr-http-response.sh
# 覆盖基础镜像的 ENTRYPOINT，让 CMD 直接运行脚本
ENTRYPOINT []
CMD ["/bin/sh", "/bridge-forward.sh"]
