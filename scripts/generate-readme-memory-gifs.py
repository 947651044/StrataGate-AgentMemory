"""Generate the localized README GIFs (requires Pillow)."""
from pathlib import Path
from functools import lru_cache
import math
from PIL import Image, ImageDraw, ImageFont

def font_path(*candidates):
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    raise FileNotFoundError(f'No usable font found among: {candidates}')

OUT=Path(__file__).resolve().parents[1]/'docs'/'assets'
W,H,S=1100,480,2
FPS,SECONDS=12,14
BG=(24,31,34); PAPER=(237,233,223); INK=(45,53,52)
WHITE=(238,235,226); MUTED=(145,155,154); ACCENT=(233,165,111)
COPY={
    'en': {
        'names':['Release','Plan','Scope','Login','UI','Tests','Access','Notes','Deploy','Perf','Docs','API'],
        'font':font_path(r'C:\Windows\Fonts\arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
        'bold':font_path(r'C:\Windows\Fonts\arialbd.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'),
        'titles':['Recent detail, older summaries','L0 stays in context','Expand when needed'],
        'question':'“When was the release?”',
        'context':'Agent context',
        'count':lambda n:f'{n} Block'+('s' if n!=1 else ''),
        'card_detail':['Demo release on Friday','Sign-in · Search'],
        'expanded':['Friday','demo release','First: sign-in and search'],
        'footer':'L0 keeps title and tags  ·  Original detail stays available',
        'asset':'short-term-memory-explainer-en.gif',
    },
    'zh': {
        'names':['发布','方案','需求','功能','界面','测试','权限','反馈','部署','性能','文档','集成'],
        'font':font_path(r'C:\Windows\Fonts\msyh.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
        'bold':font_path(r'C:\Windows\Fonts\msyhbd.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'),
        'titles':['近期详细，远期简略','L0 仍在上下文','需要时，重新展开'],
        'question':'“之前定在哪天发布？”',
        'context':'Agent 上下文',
        'count':lambda n:f'{n} 个 Block',
        'card_detail':['周五发布演示版','登录 · 搜索'],
        'expanded':['周五','发布演示版','优先完成：登录、搜索'],
        'footer':'L0 保留标题与标签  ·  原始记录可展开',
        'asset':'short-term-memory-explainer-zh.gif',
    },
}
LANG='en'

@lru_cache(maxsize=150)
def font(size,bold=False):
    copy=COPY[LANG]
    return ImageFont.truetype(copy['bold'] if bold else copy['font'],round(size*S))

def ease(a,b,t):
    x=max(0,min(1,(t-a)/(b-a)));return x*x*(3-2*x)

def lerp(a,b,p):return a+(b-a)*p

def text(d,x,y,value,size=18,color=WHITE,bold=False):
    d.text((round(x*S),round(y*S)),value,font=font(size,bold),fill=color)

def centered(d,x,y,value,size=18,color=WHITE,bold=False):
    f=font(size,bold);tw=d.textlength(value,font=f)/S
    text(d,x-tw/2,y,value,size,color,bold)

def rect(d,box,color,radius=0):
    box=tuple(round(v*S) for v in box)
    if radius:d.rounded_rectangle(box,radius=round(radius*S),fill=color)
    else:d.rectangle(box,fill=color)

def line(d,points,color,width=1):
    d.line([(round(x*S),round(y*S)) for x,y in points],fill=color,width=max(1,round(width*S)))

def level(age):
    if age<=1:return 5
    if age==2:return 4
    if age<=4:return 3
    if age<=6:return 2
    if age<=8:return 1
    return 0

def alpha(im,a):
    if a>=1:return im
    im=im.copy();im.putalpha(im.getchannel('A').point(lambda v:round(v*max(0,a))))
    return im

def background():
    im=Image.new('RGB',(W,H));px=im.load()
    for y in range(H):
        for x in range(W):
            glow=5*math.exp(-((x-660)/570)**2-((y-290)/260)**2)
            px[x,y]=tuple(round(c+glow) for c in BG)
    return im.resize((W*S,H*S),Image.Resampling.BICUBIC).convert('RGBA')

BASE=background()

def state(t):
    count=1+sum(ease(1.2+k*.68,1.68+k*.68,t) for k in range(11))
    expand=ease(9.7,10.9,t)
    return count,expand

def draw_sheet(d,x,y,w,h,index,lev,scale=1,accent=False):
    # L0 sheets stay fully visible. Only the amount of interior content changes.
    rect(d,(x+2,y+4,x+w-2,y+h+4),(123,134,126),2)
    rect(d,(x,y,x+w,y+h),PAPER,3)
    pad=max(8,w*.16)
    mark_color=ACCENT if accent else (140,156,143)
    rect(d,(x+pad,y+11*scale,x+pad+min(16,w*.22),y+13*scale),mark_color,1)
    centered(d,x+w/2,y+22*scale,COPY[LANG]['names'][index],round((22 if w>175 else 17)*scale),INK)
    # A title and tag remain even at the minimum level.
    tag_y=y+51*scale
    rect(d,(x+pad,tag_y,x+w-pad,tag_y+6*scale),(208,215,200),2)
    selected_detail=index==0 and lev>=4 and w>160 and h>170
    if selected_detail:
        text(d,x+pad,y+78*scale,COPY[LANG]['card_detail'][0],round(19*scale),INK)
        text(d,x+pad,y+111*scale,COPY[LANG]['card_detail'][1],round(16*scale),INK)
    if lev>0:
        start=148 if selected_detail else 83
        available=h-(start+9)*scale
        lines=max(0,math.floor(available/(13*scale)))
        for j in range(lines):
            yy=y+start*scale+j*13*scale
            width=(w-2*pad)*[.9,.72,1,.59][j%4]
            rect(d,(x+pad,yy,x+pad+width,yy+2*scale),(160,178,159),1)
    label='L'+str(lev)
    centered(d,x+w/2,y-28*scale,label,round(17*scale),ACCENT if accent else WHITE)

def render(t):
    im=BASE.copy();d=ImageDraw.Draw(im)
    text(d,923,19,'STRATAGATE',12,MUTED)
    count,expand=state(t)
    n0=int(count+1e-5);n1=min(12,n0+1);p=count-n0
    visible=n0+(p>0.001)
    title=COPY[LANG]['titles'][0 if t<7.15 else 1 if t<9.2 else 2]
    text(d,56,39,title,40)
    if t>=9.2:text(d,59,96,COPY[LANG]['question'],17,MUTED)

    # The context overview always contains every Block. During recall it moves
    # down as one group to make room for a detail callout.
    baseline=422
    vertical=lerp(1,.38,expand)
    overall_width=lerp(954,926,expand)
    left=lerp(56,70,expand)
    gap=lerp(13,12,expand)
    width=min(330,(overall_width+gap)/count-gap)
    slot=width+gap
    context_y=lerp(122,285,expand)
    text(d,56,context_y,COPY[LANG]['context'],16,MUTED)
    shown_count=n0+(p>.5)
    count_label=COPY[LANG]['count'](shown_count)
    text(d,808,context_y,count_label,16,WHITE)
    line(d,[(56,context_y+32),(1043,context_y+32)],(65,79,79))

    # All existing IDs are kept, with no age-based removal or off-screen exit.
    selected_center=0
    for i in range(visible):
        new=i==n0
        a=p if new else 1
        prev=level(max(0,n0-i-1));nxt=level(max(0,n1-i-1))
        interpolated=lerp(prev,nxt,p) if not new else 5
        shown_level=nxt if p>.5 else prev
        if new:shown_level=5
        if i==0:
            interpolated=lerp(interpolated,5,expand)
            if expand>.5:shown_level=5
        h=max(56*expand,min((78+interpolated*34+max(0,width-234)*.35)*vertical,baseline-(context_y+68)))
        x=left+i*slot
        y=baseline-h+(1-a)*16
        layer=Image.new('RGBA',im.size,(0,0,0,0));ld=ImageDraw.Draw(layer)
        draw_sheet(ld,x,y,width,h,i,shown_level,lerp(1,.76,expand),i==0)
        centered(ld,x+width/2,baseline+14,str(i+1).zfill(2),round(14*lerp(1,.9,expand)),ACCENT if i==0 else MUTED)
        im.alpha_composite(alpha(layer,a))
        if i==0:selected_center=x+width/2

    d=ImageDraw.Draw(im)
    # The open-ended append sign stays visible as the context grows.
    plus_y=lerp(315,395,expand)
    plus_x=min(1041,left+count*slot+15)
    line(d,[(plus_x-10,plus_y),(plus_x+10,plus_y)],MUTED,1)
    line(d,[(plus_x,plus_y-10),(plus_x,plus_y+10)],MUTED,1)

    if expand>0:
        detail=Image.new('RGBA',im.size,(0,0,0,0));dd=ImageDraw.Draw(detail)
        xx,yy,ww,hh=227,131,424,142
        rect(dd,(xx+3,yy+5,xx+ww-3,yy+hh+5),(110,122,115),3)
        rect(dd,(xx,yy,xx+ww,yy+hh),PAPER,4)
        text(dd,xx+25,yy+10,'Block 01   ·   L5',13,(154,96,62))
        text(dd,xx+24,yy+34,COPY[LANG]['expanded'][0],40,INK,True)
        text(dd,xx+(134 if LANG=='zh' else 155),yy+57,COPY[LANG]['expanded'][1],20,INK)
        text(dd,xx+26,yy+101,COPY[LANG]['expanded'][2],19,INK)
        # The matching Block number and warm accent identify the expanded sheet.
        im.alpha_composite(alpha(detail,expand))

    d=ImageDraw.Draw(im)
    rect(d,(58,465,62,469),ACCENT,1)
    text(d,73,457,COPY[LANG]['footer'],13,MUTED)
    # A quiet fade distinguishes the loop boundary from a block disappearing.
    if t>13.3:
        fade=ease(13.3,13.95,t)
        im=Image.blend(im,BASE,fade)
    return im.convert('RGB').resize((W,H),Image.Resampling.LANCZOS)

def main():
    global LANG
    OUT.mkdir(parents=True,exist_ok=True)
    for LANG in ('en','zh'):
        font.cache_clear()
        palette=render(4.5).quantize(colors=112,method=Image.Quantize.MEDIANCUT)
        frames=[render(i/FPS).quantize(palette=palette,dither=Image.Dither.NONE) for i in range(FPS*SECONDS)]
        durations=[80 if i%3<2 else 90 for i in range(len(frames))]
        target=OUT/COPY[LANG]['asset']
        frames[0].save(target,save_all=True,append_images=frames[1:],duration=durations,loop=0,optimize=True,disposal=1)
        print(f'{target}: {target.stat().st_size/1024/1024:.2f} MiB')

if __name__=='__main__':main()
