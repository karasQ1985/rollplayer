# -*- coding: utf-8 -*-
"""生成 45 个短正弦波 wav 测试音频（用于验证扫描 / 调度 / 播放链路）。
运行: python tools/make_test_media.py
"""
import math
import os
import struct
import wave

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test-media')
os.makedirs(OUT, exist_ok=True)

for i in range(1, 46):
    dur = 1.0 + (i % 5) * 0.25
    n = int(SR * dur)
    freq = 220 * (i % 12 + 1)
    path = os.path.join(OUT, 'test_%03d.wav' % i)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = b''.join(
            struct.pack('<h', int(12000 * math.sin(2 * math.pi * freq * t / SR) * (1 - t / n * 0.3)))
            for t in range(n)
        )
        w.writeframes(frames)
    print('generated', os.path.basename(path))

print('done ->', OUT)
