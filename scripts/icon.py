"""Generate the simple geometric application icon, using only Python's standard library."""
import math, struct, zlib
from pathlib import Path

def segment_distance(x, y, x1, y1, x2, y2):
    dx, dy = x2-x1, y2-y1
    t = max(0, min(1, ((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy)))
    return math.hypot(x-x1-t*dx, y-y1-t*dy)

def chunk(kind, data):
    return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data) & 0xffffffff)

size = 1024
rows = []
for y in range(size):
    row = bytearray([0])
    for x in range(size):
        # Rounded, inset tile; the arrow repeats the in-app mark.
        qx, qy = max(abs(x-512)-300, 0), max(abs(y-512)-300, 0)
        d = math.hypot(qx, qy)-140
        alpha = max(0, min(255, round((1-d)*255)))
        arrow = min(segment_distance(x,y,345,680,675,350), segment_distance(x,y,440,350,675,350), segment_distance(x,y,675,350,675,585))
        mix = max(0, min(1, 37-arrow))
        base = (round(67*(1-y/size)), round(157*(1-y/size)+112*y/size), round(255*(1-y/size)+239*y/size))
        color = tuple(round(a*(1-mix)+b*mix) for a,b in zip(base,(255,255,255)))
        row.extend((*color,alpha))
    rows.append(row)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B',size,size,8,6,0,0,0)) + chunk(b'IDAT',zlib.compress(b''.join(rows),9)) + chunk(b'IEND',b'')
Path('assets/icon.png').write_bytes(png)
