FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY shop.py .
USER nobody
CMD ["python", "-u", "shop.py"]
