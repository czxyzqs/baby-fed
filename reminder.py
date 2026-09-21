#!/usr/bin/env python3
"""
婴儿喂奶提醒 — 通过小爱同学播报
从 data/records/ 下的月度 JSON 分片读取记录，
在 +1h、+2h、+3h 通过小爱同学语音提醒。

用法（独立运行）:
    python3 /data/learning/baby/reminder.py schedule <feed_time_iso> <amount_ml>
    python3 /data/learning/baby/reminder.py check
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from storage import JsonRecordStore

# ========== 配置 ==========
DATA_DIR = os.getenv('BABY_DATA_DIR', str(Path(__file__).resolve().parent / 'data'))
record_store = JsonRecordStore(DATA_DIR)
XIAOAI_BASE_URL = os.environ.get("XIAOAI_BASE_URL", "http://host.docker.internal:9092")
# ==========================


def xiaoai_speak(text: str, timeout: int = 30) -> bool:
    """通过 open-xiaoai-bridge HTTP API 让小爱同学说话"""
    import urllib.request, urllib.error

    payload = json.dumps({"text": text}).encode()
    req = urllib.request.Request(
        f"{XIAOAI_BASE_URL}/api/play/text",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read())
            ok = result.get("success", False)
            print(f"[小爱] {'OK' if ok else 'FAIL'}: {text}", flush=True)
            return ok
    except urllib.error.URLError as e:
        print(f"[小爱] ERROR: {e}", flush=True)
        return False


def get_latest_new_milk():
    """从月度分片读取最新的 isNewMilk=true 记录"""
    try:
        records = record_store.read_records()
        milk_records = [
            r for r in records
            if r.get("type") == "feed" and r.get("isNewMilk") is True
        ]
        if not milk_records:
            return None
        # 按时间倒序取最新
        milk_records.sort(key=lambda r: r.get("time", ""), reverse=True)
        return milk_records[0]
    except Exception as e:
        print(f"[reminder] 读取记录失败: {e}", flush=True)
        return None


def schedule_reminders(feed_time: datetime, amount_ml: int):
    """
    在后台 fork 出子进程，等待 +1h、+2h、+3h 触发小爱语音提醒。
    fork 后父进程立即返回。
    """
    pid = os.fork()
    if pid != 0:
        print(f"[reminder] 后台提醒进程 PID={pid} 已启动，feed_time={feed_time.isoformat()}", flush=True)
        return

    # === 子进程 ===
    os.close(0)
    os.close(1)
    os.close(2)

    def wait_until(target: datetime, label: str, final: bool = False):
        """等待到达 target 时间，然后播报 label"""
        now = datetime.now()
        if target <= now:
            # 已过时间，立即播报
            if final:
                xiaoai_speak("该喂奶了")
            else:
                xiaoai_speak(label)
            return

        wait_secs = (target - now).total_seconds()
        print(f"[reminder] 等待 {wait_secs:.0f}秒 → {target.strftime('%H:%M')} {label}", flush=True)
        time.sleep(wait_secs)

        if final:
            xiaoai_speak("该喂奶了")
        else:
            xiaoai_speak(label)

    # 计算提醒时间点
    next_feed = feed_time + timedelta(hours=3)
    t1 = feed_time + timedelta(hours=1)   # +1h 倒计时2h
    t2 = feed_time + timedelta(hours=2)   # +2h 倒计时1h
    t3 = next_feed                          # +3h 该喂奶

    print(f"[reminder] 提醒时间: {t1.strftime('%H:%M')} 倒计时2h | {t2.strftime('%H:%M')} 倒计时1h | {t3.strftime('%H:%M')} 该喂奶了", flush=True)

    try:
        wait_until(t1, "喂奶倒计时两小时")
        wait_until(t2, "喂奶倒计时一小时")
        wait_until(t3, "time_to_feed", final=True)
    except Exception as e:
        print(f"[reminder] 子进程异常: {e}", flush=True)

    sys.exit(0)


def check_and_remind():
    """
    整点检查：距下次喂奶 ≤15 分钟时提前提醒。
    由外部 cron 或直接调用。
    """
    record = get_latest_new_milk()
    if not record:
        print("[reminder] 暂无新奶记录", flush=True)
        return

    try:
        feed_time = datetime.fromisoformat(record["time"].replace("Z", "+00:00").replace("+08:00", ""))
    except Exception:
        # 有些时间带时区后缀，有些不带，尝试解析
        try:
            feed_time = datetime.fromisoformat(record["time"].split("+")[0].replace("Z", ""))
        except Exception:
            feed_time = datetime.fromisoformat(record["time"])

    next_feed = feed_time + timedelta(hours=3)
    now = datetime.now()

    print(f"[reminder] 检查: feed={feed_time.strftime('%H:%M')} next={next_feed.strftime('%H:%M')} now={now.strftime('%H:%M:%S')}", flush=True)

    remaining = (next_feed - now).total_seconds()

    # 已到喂奶时间
    if remaining <= 0:
        xiaoai_speak("该喂奶了")
        print("[reminder] 到点提醒: 该喂奶了")
        return

    # 距下次喂奶 ≤15 分钟，提前提示"倒计时X小时"
    if remaining <= 15 * 60:
        hours = remaining / 3600
        if hours <= 0.5:
            xiaoai_speak("喂奶倒计时一小时")
            print(f"[reminder] 提前15min提醒: 喂奶倒计时一小时（剩余{hours*60:.0f}分钟）")
        elif hours <= 1.5:
            xiaoai_speak("喂奶倒计时两小时")
            print(f"[reminder] 提前提醒: 喂奶倒计时两小时（剩余{hours*60:.0f}分钟）")
        else:
            print(f"[reminder] 距下次喂奶剩余 {hours:.1f}小时，不提醒")
        return

    print(f"[reminder] 距下次喂奶 {remaining/3600:.1f}小时，无需提醒", flush=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"

    if cmd == "schedule":
        if len(sys.argv) < 3:
            print("用法: reminder.py schedule <iso_datetime> <amount_ml>")
            sys.exit(1)
        feed_time = datetime.fromisoformat(sys.argv[2])
        amount_ml = int(sys.argv[3]) if len(sys.argv) > 3 else 0
        schedule_reminders(feed_time, amount_ml)

    elif cmd == "check":
        check_and_remind()

    elif cmd == "speak":
        text = sys.argv[2] if len(sys.argv) > 2 else "小爱同学测试"
        xiaoai_speak(text)

    else:
        print(__doc__)
