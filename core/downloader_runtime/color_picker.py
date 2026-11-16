"""Local screen eyedropper. Images remain in memory and are never uploaded."""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import tkinter as tk
from tkinter import messagebox
from PIL import ImageGrab,ImageTk
from tkinter import ttk

from desktop_ui import PALETTES, apply_appearance, bind_scale_wheel


def _palette_file():
    try:
        from app_settings import settings_location
        return settings_location().parent/'custom-colors.json'
    except Exception:
        return Path(__file__).resolve().parent/'custom-colors.json'


def _read_palette():
    try:
        data=json.loads(_palette_file().read_text(encoding='utf-8'))
        return list(dict.fromkeys(c for c in data if isinstance(c,str) and len(c)==7 and c.startswith('#')))[:24]
    except (OSError,ValueError,TypeError):return []


def _save_palette(colors):
    path=_palette_file();path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(list(dict.fromkeys(colors))[:24],ensure_ascii=False,indent=2),encoding='utf-8')


def _remember_color(color):
    colors=_read_palette()
    if color in colors:colors.remove(color)
    _save_palette([color,*colors])


def askcolor(color=None, parent=None, **kwargs):
    """Compact in-app color picker with RGB controls and screen sampling."""
    window=tk.Toplevel(parent);window.title('颜色')
    window.resizable(False,False);apply_appearance(window,'深色')
    if parent is not None:
        window.transient(parent)
    colors=PALETTES['深色'];value=tk.StringVar(value=color or '#ffffff');result=[None]
    rgb_vars=[tk.IntVar(value=255) for _ in range(3)]
    swatch=tk.Frame(window,height=52,background=value.get(),highlightthickness=1,
                    highlightbackground=colors['border']);swatch.pack(fill='x',padx=16,pady=(14,10))
    entry_row=ttk.Frame(window);entry_row.pack(fill='x',padx=16)
    ttk.Label(entry_row,text='HEX').pack(side='left',padx=(0,8))
    hex_entry=ttk.Entry(entry_row,textvariable=value,width=18);hex_entry.pack(side='left',fill='x',expand=True)
    ttk.Label(window,text='RGB 色彩通道',foreground=colors['muted']).pack(anchor='w',padx=16,pady=(12,2))
    rgb_panel=ttk.Frame(window);rgb_panel.pack(fill='x',padx=16)
    channels=[]
    for index,(label,var) in enumerate(zip(('R','G','B'),rgb_vars)):
        ttk.Label(rgb_panel,text=label,width=2).grid(row=index,column=0,sticky='w',pady=2)
        scale=ttk.Scale(rgb_panel,from_=0,to=255,variable=var,style='Horizontal.TScale')
        scale.grid(row=index,column=1,sticky='ew',padx=6,pady=2);bind_scale_wheel(scale,step=1)
        number=ttk.Label(rgb_panel,textvariable=var,width=4,anchor='e')
        number.grid(row=index,column=2,sticky='e')
        channels.append(scale)
    rgb_panel.columnconfigure(1,weight=1)
    palette_row=ttk.Frame(window);palette_row.pack(padx=14,pady=(9,0),fill='x')
    palette_label=ttk.Label(window,text='常用色（右键色块可删除）',foreground=colors['muted'])
    def refresh_palette():
        for child in palette_row.winfo_children():child.destroy()
        saved=_read_palette()
        choices=saved or ['#ffffff','#cfd2d6','#80858b','#303236','#101112',
                           '#b8d7d2','#68a9a2','#d8b66b','#d87575','#917dcc']
        for chosen in choices:
            chip=tk.Button(palette_row,text=' ',width=3,background=chosen,activebackground=chosen,
                           command=lambda c=chosen:update(c))
            chip.configure(relief='flat',bd=0,highlightthickness=1,
                           highlightbackground=colors['border'],highlightcolor=colors['select'],cursor='hand2')
            chip.pack(side='left',padx=2)
            chip.bind('<Button-3>',lambda e,c=chosen:remove_color(c))
    def remember(chosen):
        if not chosen:return
        _remember_color(chosen);refresh_palette()
    def remove_color(chosen):
        _save_palette([c for c in _read_palette() if c!=chosen]);refresh_palette()
    def update(chosen):
        if not isinstance(chosen,str) or len(chosen)!=7 or not chosen.startswith('#'):
            return
        try:rgb=[int(chosen[i:i+2],16) for i in (1,3,5)]
        except ValueError:return
        value.set(chosen.lower())
        for var,component in zip(rgb_vars,rgb):var.set(component)
        value.set(chosen.lower())
        swatch.configure(background=chosen);window.deiconify();window.lift()
    def update_from_rgb(*_):
        chosen='#'+''.join(f'{max(0,min(255,int(var.get()))):02x}' for var in rgb_vars)
        value.set(chosen);swatch.configure(background=chosen)
    for var in rgb_vars:var.trace_add('write',update_from_rgb)
    def update_from_hex(_event=None):
        update(value.get())
    def palette():
        if palette_row.winfo_manager():
            palette_row.pack_forget();palette_label.pack_forget()
        else:
            palette_label.pack(anchor='w',padx=16,pady=(8,0))
            palette_row.pack(padx=12,pady=(3,0),fill='x')
    def sample():
        window.withdraw();pick_screen_color(parent,update,on_cancel=window.deiconify)
    def confirm():
        try:
            rgb=window.winfo_rgb(value.get());result[0]=(tuple(v//257 for v in rgb),value.get());_remember_color(value.get());window.destroy()
        except tk.TclError:pass
    update(value.get());refresh_palette();palette_row.pack_forget()
    hex_entry.bind('<Return>',update_from_hex);hex_entry.bind('<FocusOut>',update_from_hex)
    row=ttk.Frame(window);row.pack(padx=12,pady=12)
    for label,command in [('调色板',palette),('吸管',sample),('确定',confirm),('取消',window.destroy)]:
        ttk.Button(row,text=label,command=command).pack(side='left',padx=3)
    window.update_idletasks()
    width=max(340,window.winfo_reqwidth());height=window.winfo_reqheight()
    if parent is not None and parent.winfo_exists():
        x=parent.winfo_rootx()+(parent.winfo_width()-width)//2
        y=parent.winfo_rooty()+(parent.winfo_height()-height)//2
    else:
        x=(window.winfo_screenwidth()-width)//2;y=(window.winfo_screenheight()-height)//2
    window.geometry(f'{width}x{height}+{max(0,x)}+{max(0,y)}')
    window.grab_set()
    window.wait_window();return result[0] or (None,None)


def pixel_color(image,x,y):
    x=max(0,min(image.width-1,int(x)));y=max(0,min(image.height-1,int(y)))
    red,green,blue=image.convert('RGB').getpixel((x,y))
    return f'#{red:02x}{green:02x}{blue:02x}'


def pick_screen_color(parent,on_pick,on_cancel=None):
    try:
        screenshot=ImageGrab.grab(all_screens=True).convert('RGB')
        user32=ctypes.windll.user32
        user32.GetAncestor.argtypes=[wintypes.HWND,wintypes.UINT];user32.GetAncestor.restype=wintypes.HWND
        user32.SetWindowPos.argtypes=[wintypes.HWND,wintypes.HWND,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,wintypes.UINT]
        origin_x=user32.GetSystemMetrics(76);origin_y=user32.GetSystemMetrics(77)
        window=tk.Toplevel(parent);window.overrideredirect(True)
        if parent is not None:
            window.transient(parent)
        width,height=screenshot.size;window.geometry(f'{width}x{height}+0+0')
        canvas=tk.Canvas(window,highlightthickness=0,cursor='crosshair');canvas.pack(fill='both',expand=True)
        photo=ImageTk.PhotoImage(screenshot,master=window);canvas.create_image(0,0,anchor='nw',image=photo)
        canvas.create_text(20,20,anchor='nw',text='点击取色 / Esc 取消 · 移动鼠标查看放大镜',fill='white',font=('Arial',14,'bold'))
        window.photo=photo
        lens_side=13;lens_zoom=10;lens_size=lens_side*lens_zoom
        lens=canvas.create_image(0,0,anchor='nw',tags=('lens',))
        lens_border=canvas.create_rectangle(0,0,1,1,outline='#ffffff',width=3,tags=('lens-border',))
        lens_inner=canvas.create_rectangle(0,0,1,1,outline='#222222',width=1,tags=('lens-border',))
        lens_photo=[None]
        def magnify(event):
            sx=event.x-origin_x;sy=event.y-origin_y;r=lens_side//2
            crop=screenshot.crop((sx-r,sy-r,sx+r+1,sy+r+1)).resize((lens_size,lens_size),Image.Resampling.NEAREST)
            lens_photo[0]=ImageTk.PhotoImage(crop,master=window)
            x=min(max(10,event.x+24),max(10,width-lens_size-10));y=min(max(40,event.y+24),max(40,height-lens_size-10))
            canvas.coords(lens,x,y);canvas.itemconfigure(lens,image=lens_photo[0])
            canvas.coords(lens_border,x-2,y-2,x+lens_size+2,y+lens_size+2)
            canvas.coords(lens_inner,x,y,x+lens_size,y+lens_size)
            canvas.tag_raise('lens');canvas.tag_raise('lens-border')
            color=pixel_color(screenshot,sx,sy)
            canvas.delete('lens-readout')
            canvas.create_rectangle(x,y+lens_size+4,x+lens_size,y+lens_size+30,fill='#111111',outline='#ffffff',tags='lens-readout')
            canvas.create_text(x+lens_size//2,y+lens_size+17,text=color,fill='white',font=('Arial',12,'bold'),tags='lens-readout')
        canvas.bind('<Motion>',magnify)
        window.update_idletasks()
        handle=user32.GetAncestor(window.winfo_id(),2)
        # Put the temporary eyedropper overlay above normal windows without
        # marking it as globally always-on-top.
        user32.SetWindowPos(handle,wintypes.HWND(0),origin_x,origin_y,width,height,0)
        def choose(event):
            color=pixel_color(screenshot,event.x-origin_x,event.y-origin_y)
            _remember_color(color)
            window.grab_release();window.destroy();on_pick(color)
        canvas.bind('<Button-1>',choose)
        def cancel(event=None):
            window.destroy()
            if on_cancel:on_cancel()
        window.bind('<Escape>',cancel)
        window.focus_force();window.grab_set()
    except Exception as exc:
        if on_cancel:on_cancel()
        messagebox.showerror('无法取色',str(exc),parent=parent)
