FROM python:3.12-slim

WORKDIR /app
COPY tts-server/local-python/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PORT=7860
EXPOSE 7860

CMD ["python", "tts-server/local-python/server.py"]
