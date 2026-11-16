import sys
from PIL import Image, ImageDraw

def draw(size):
    S = 512
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([16, 16, S - 16, S - 16], radius=112, fill=(29, 29, 27, 255))
    # package box outline
    d.rounded_rectangle([110, 150, 402, 402], radius=28, outline=(236, 235, 230, 255), width=30)
    d.line([110, 230, 402, 230], fill=(236, 235, 230, 255), width=30)
    # check mark over the lid
    d.line([(190, 320), (245, 372), (360, 262)], fill=(111, 207, 151, 255), width=44, joint="curve")
    return im.resize((size, size), Image.LANCZOS)

out = sys.argv[1]
for s in (16, 32, 48, 128):
    draw(s).save(f"{out}/icon{s}.png")
