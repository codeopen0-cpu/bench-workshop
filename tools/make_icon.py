"""Draws Bench Workshop's app icon (a workbench with a board and a gear on it) at 1024 px.
    python tools/make_icon.py && npx tauri icon tools/icon.png
"""
import math
import os

from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=(30, 33, 40, 255))

# bench top + legs
d.rounded_rectangle([150, 560, 874, 640], radius=24, fill=(79, 156, 255, 255))
d.rectangle([210, 640, 270, 860], fill=(47, 111, 209, 255))
d.rectangle([754, 640, 814, 860], fill=(47, 111, 209, 255))
d.rectangle([270, 760, 754, 790], fill=(47, 111, 209, 255))

# a green circuit board on the bench
d.rounded_rectangle([210, 430, 520, 560], radius=14, fill=(47, 125, 79, 255))
for x in range(240, 500, 52):
    d.ellipse([x, 455, x + 22, 477], fill=(232, 197, 71, 255))
d.rectangle([300, 495, 420, 545], fill=(28, 30, 34, 255))

# a gear standing on the bench
cx, cy, r = 680, 420, 140
teeth = 10
pts = []
for i in range(teeth * 2):
    a = i * math.pi / teeth
    rr = r if i % 2 == 0 else r * 0.78
    for da in (-0.13, 0.13):
        pts.append((cx + rr * math.cos(a + da), cy + rr * math.sin(a + da)))
d.polygon(pts, fill=(232, 197, 71, 255))
d.ellipse([cx - 52, cy - 52, cx + 52, cy + 52], fill=(30, 33, 40, 255))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")
img.save(out)
print("saved", out)
