FROM alpine
RUN cat /poison.txt || echo "clean"