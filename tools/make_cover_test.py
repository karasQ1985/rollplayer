# -*- coding: utf-8 -*-
"""构造一个带内嵌封面(APIC)的最小 mp3，用于验证 /api/cover 提取逻辑。
运行: python tools/make_cover_test.py
"""
import base64
import os
import struct

# 1x1 像素 PNG
PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
)


def syncsafe(n):
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])


payload = b'\x00' + b'image/png\x00' + b'\x00' + b'\x00' + PNG  # enc + mime + type + 空描述 + 图数据
frame = b'APIC' + struct.pack('>I', len(payload)) + b'\x00\x00' + payload
body = frame
header = b'ID3' + b'\x04\x00' + b'\x00' + syncsafe(len(body))
audio = b'\xff\xfb\x90\x64' + b'\x00' * 200  # 假音频帧，仅够触发文件头解析

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test-media', 'cover_test.mp3')
with open(out, 'wb') as f:
    f.write(header + body + audio)
print('written', out, 'total', len(header + body + audio))
