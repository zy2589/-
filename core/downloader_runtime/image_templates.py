"""Landscape template 2 using template 1 copy and adaptive title layout."""
import json
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


DEFAULT_TEMPLATE_2 = {"phone": "+1(812)239-2088", "title": "", "promo_scale": 100, "promo_padding": 49}
TEMPLATE_1_COPY = "Message us on Whats/App at\n{phone}\nto join our FREE online Bible study."
TEMPLATE_2_FOOTER = "LINK IN MY BIO"


def template_2_asset():
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    cleaned = root / "assets" / "template_2_background_clean.png"
    return cleaned if cleaned.exists() else root / "assets" / "template_2_background.png"


def read_template_2(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        return {**DEFAULT_TEMPLATE_2,
                **{key: value[key] for key in DEFAULT_TEMPLATE_2 if key in value}}
    except (OSError, ValueError, TypeError):
        return dict(DEFAULT_TEMPLATE_2)


def save_template_2(path, phone, promo_scale=100, promo_padding=49, title=None):
    phone = str(phone or "").strip()
    if not re.fullmatch(r"\+\s*\d[\d ()\-]{6,}\d", phone):
        raise ValueError("模板号码请包含国家区号，例如 +1(812)239-2088")
    previous=read_template_2(path)
    data={"phone": phone,
          "title": str(previous.get('title','') if title is None else title).strip(),
          "promo_scale": max(70,min(150,int(promo_scale))),
          "promo_padding": max(15,min(120,int(promo_padding)))}
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2),
                          encoding="utf-8")


def _font(size, bold=True):
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    path = root / "fonts" / "EBGaramond-Variable.ttf"
    if not path.exists():
        path = Path("C:/Windows/Fonts/timesbd.ttf" if bold else "C:/Windows/Fonts/times.ttf")
    font = ImageFont.truetype(str(path), size)
    if path.name.startswith("EBGaramond-"):
        font.set_variation_by_axes([700 if bold else 400])
    return font


def _copy_font(size):
    path=Path("C:/Windows/Fonts/arialbd.ttf")
    if not path.exists():
        return _font(size)
    return ImageFont.truetype(str(path),size)


def _wrap_title(title, max_width, max_height, max_lines=3):
    from local_design import balanced_lines
    words = str(title or "").split()
    if not words:
        return [], 0
    # Keep short titles on one line. For longer titles, prefer two balanced
    # lines and shrink to fit before using a third line.
    for size in range(100, 69, -2):
        face=_font(size)
        line=" ".join(words)
        box=face.getbbox(line)
        if face.getlength(line)<=max_width and box[3]-box[1]<=max_height:
            return [line],size
    for count in range(2,max_lines+1):
        for size in range(100,43,-2):
            face=_font(size)
            lines=balanced_lines(" ".join(words),count,face.getlength)
            boxes=[face.getbbox(line) for line in lines]
            height=sum(box[3]-box[1] for box in boxes)+max(0,len(lines)-1)*6
            if height<=max_height and all(face.getlength(line)<=max_width for line in lines):
                return lines,size
    # Long unbroken title: shrink it to fit one line within the title plate.
    face=_font(44)
    line=" ".join(words)
    while face.getlength(line)>max_width and face.size>24:
        face=_font(face.size-1)
    return [line],face.size


def _adaptive_title_frame(source, width, height):
    """Resize a title frame while preserving its ornaments and rail thickness."""
    scale=height/source.height
    base_w=round(source.width*scale)
    base=source.resize((base_w,height),Image.Resampling.LANCZOS)
    # Keep left/right corners, side flares, and the top/bottom center star
    # intact. Only extend the straight rail sections between those ornaments.
    left_cap=round(230*scale)
    right_cap=base_w-left_cap
    star_left=round(865*scale)
    star_right=round(1037*scale)
    if width<=base_w or star_left<=left_cap or star_right>=right_cap:
        return base.resize((width,height),Image.Resampling.LANCZOS)
    fixed=(left_cap+(base_w-right_cap)+(star_right-star_left))
    extension=width-fixed
    left_source=star_left-left_cap
    right_source=right_cap-star_right
    left_target=round(extension*left_source/(left_source+right_source))
    right_target=extension-left_target
    pieces=[
        (base.crop((0,0,left_cap,height)),left_cap),
        (base.crop((left_cap,0,star_left,height)),left_target),
        (base.crop((star_left,0,star_right,height)),star_right-star_left),
        (base.crop((star_right,0,right_cap,height)),right_target),
        (base.crop((right_cap,0,base_w,height)),base_w-right_cap),
    ]
    result=Image.new("RGBA",(width,height),(0,0,0,0))
    x=0
    for piece,piece_width in pieces:
        if piece_width<=0:
            continue
        if piece.width!=piece_width:
            piece=piece.resize((piece_width,height),Image.Resampling.LANCZOS)
        result.alpha_composite(piece,(x,0))
        x+=piece_width
    return result


def _draw_centered(draw, text, y, face, fill, canvas_width=1902, stroke_width=0, stroke_fill=None):
    box=draw.textbbox((0,0),text,font=face,stroke_width=stroke_width)
    x=(canvas_width-(box[2]-box[0]))/2-box[0]
    draw.text((round(x),y-box[1]),text,font=face,fill=fill,
              stroke_width=stroke_width,stroke_fill=stroke_fill)


def _draw_mixed_centered(draw, runs, y, face, canvas_width=1080):
    width=sum(face.getlength(text) for text,_ in runs)
    x=(canvas_width-width)/2
    box=face.getbbox("Ag")
    y-=box[1]
    for text,color in runs:
        draw.text((round(x),y),text,font=face,fill=color)
        x+=face.getlength(text)


def render_template_2(phone, title=None, preview_size=None, settings=None, show_promo=True):
    settings=settings or {}
    source=Image.open(template_2_asset()).convert("RGBA")
    canvas=Image.new("RGBA",(1080,1920),(0,0,0,0))
    # Fit title to a maximum safe area first, then size its frame to the actual
    # rendered text bounds. The promotion gets its own independently measured frame.
    title_lines,title_size=_wrap_title(title,850,330,max_lines=3)
    title_face=_font(title_size) if title_lines else None
    title_heights=([title_face.getbbox(line)[3]-title_face.getbbox(line)[1]
                    for line in title_lines] if title_lines else [])
    title_gap=5
    title_text_w=max((title_face.getlength(line) for line in title_lines),default=0) if title_lines else 0
    title_text_h=sum(title_heights)+max(0,len(title_heights)-1)*title_gap
    # Size the title frame to its text; preserve corner art and extend only
    # straight rails. Leave the title frame out entirely for promo-only output.
    source_w,source_h=source.size
    if title_lines:
        title_w=max(480,min(1040,round(title_text_w+118)))
        # Keep the title frame's metal rails visually as thick as the promo frame.
        title_h=max(280,min(500,round(title_text_h+138)))
        title_panel=_adaptive_title_frame(source,title_w,title_h)
        title_panel_x=(1080-title_w)//2
        title_panel_y=790-title_h//2
        canvas.alpha_composite(title_panel,(title_panel_x,title_panel_y))

        # The upper framed card contains only the adaptive video title.
        title_draw=ImageDraw.Draw(canvas)
        y=title_panel_y+(title_h-title_text_h)//2
        for line,height in zip(title_lines,title_heights):
            _draw_centered(title_draw,line,y,title_face,"#16100d",canvas_width=1080,
                           stroke_width=1,stroke_fill="#16100d")
            y+=height+title_gap

    # The lower framed card contains only template 1's promotion copy.
    if not show_promo:
        if preview_size:
            canvas.thumbnail(preview_size,Image.Resampling.LANCZOS)
        return canvas
    body=["Message us on Whats/App at",str(phone or "").strip(),
          "to join our FREE online Bible study."]
    factor=max(.70,min(1.50,float(settings.get('promo_scale',100))/100))
    body_sizes=[round(v*factor) for v in (36,52,36,42)]
    body.append(TEMPLATE_2_FOOTER)
    body_faces=[]; body_heights=[]; body_widths=[]
    for text,size in zip(body,body_sizes):
        face=_copy_font(size)
        max_width=850
        while face.getlength(text)>max_width and face.size>25:
            face=_copy_font(face.size-1)
        box=face.getbbox(text)
        body_faces.append(face)
        body_heights.append(box[3]-box[1])
        body_widths.append(face.getlength(text))
    body_gap=15
    body_text_h=sum(body_heights)+body_gap*(len(body)-1)
    body_text_w=max(body_widths)
    padding=max(15,min(120,int(settings.get('promo_padding',49))))
    promo_scale=max((body_text_w+padding*2)/(source_w-176),
                    (body_text_h+padding*2)/(source_h-156))
    promo_scale=max(.30,min(.56,promo_scale))
    promo_w=round(source_w*promo_scale)
    promo_h=round(source_h*promo_scale)
    promo_panel=source.resize((promo_w,promo_h),Image.Resampling.LANCZOS)
    promo_x=(1080-promo_w)//2
    promo_y=1460-promo_h//2
    canvas.alpha_composite(promo_panel,(promo_x,promo_y))
    promo_draw=ImageDraw.Draw(canvas)
    y=promo_y+(promo_h-body_text_h)//2
    for index,(text,face,height) in enumerate(zip(body,body_faces,body_heights)):
        if index==1 or text==TEMPLATE_2_FOOTER:
            runs=[(text,"#e15f35")]
        elif index==2:
            before,after=text.split("FREE",1)
            runs=[(before,"#111111"),("FREE","#e15f35"),(after,"#111111")]
        else:
            runs=[(text,"#111111")]
        _draw_mixed_centered(promo_draw,runs,y,face,canvas_width=1080)
        y+=height+body_gap

    if preview_size:
        canvas.thumbnail(preview_size,Image.Resampling.LANCZOS)
    return canvas
