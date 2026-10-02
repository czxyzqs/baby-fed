FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install dependencies
# opencv (rapidocr) 运行需要这些图像/X11 库
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 libxcb1 libsm6 libice6 libxext6 \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY baby.py .
COPY reminder.py .
COPY storage.py .
COPY food_library.py .
COPY food_entries.py .
COPY food_screening.py .
COPY food_ocr.py .
COPY templates/ templates/
COPY static/ static/

# Expose port
EXPOSE 8888

# Run
CMD ["gunicorn", "--bind", "0.0.0.0:8888", "--workers", "2", "--threads", "4", "--timeout", "120", "baby:app"]
