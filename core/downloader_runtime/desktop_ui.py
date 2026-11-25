"""Shared compact Windows desktop styling and native icon controls."""
import os
import sys
from pathlib import Path
import tkinter as tk
from tkinter import ttk


PALETTES = {
    '浅色': dict(bg='#f2f3f5', field='#ffffff', fg='#242629', button='#e5e7ea',
                 border='#c8cbd0', select='#4b8d86', disabled='#858a91',
                 muted='#686e75', hover='#d9dde1', toolbar='#e8eaed',
                 primary='#eceeef', primary_bottom='#cfd2d6', primary_fg='#17191c',
                 scroll='#858b92', scroll_active='#5c6269', trough='#d9dde1'),
    '深色': dict(bg='#111213', field='#191a1c', fg='#eff0f1', button='#252629',
                 border='#404247', select='#4e7775', disabled='#73777d',
                 muted='#a0a3a8', hover='#303236', toolbar='#191a1c',
                 primary='#f0f1f2', primary_bottom='#cdd0d4', primary_fg='#17191c',
                 scroll='#46494e', scroll_active='#6c7076', trough='#111213'),
}

ICONS = dict(copy='\ue8c8', undo='\ue7a7', redo='\ue7a6', history='\ue81c',
             more='\ue712', folder='\ue8b7', download='\ue896', cancel='\ue711',
             clear='\ue74d', settings='\ue713', note='\ue70b', tidy='\ue8d2',
             search='\ue721', sun='\ue706', moon='\ue708', fill='\ue8b5')
ICON_FONT = ('Segoe MDL2 Assets', 12)
UI_FONT = ('Microsoft YaHei UI', 10)


class ToolTip:
    def __init__(self, widget, text):
        self.widget, self.text = widget, text
        self.pending, self.window = None, None
        widget.bind('<Enter>', self.enter, add='+')
        widget.bind('<Leave>', self.hide, add='+')
        widget.bind('<ButtonPress>', self.hide, add='+')
        widget.bind('<Destroy>', self.hide, add='+')

    def enter(self, event=None):
        self.hide()
        self.pending = self.widget.after(450, self.show)

    def show(self):
        self.pending = None
        if not self.widget.winfo_exists():
            return
        self.window = tk.Toplevel(self.widget)
        self.window.overrideredirect(True)
        self.window.transient(self.widget.winfo_toplevel())
        self.window.geometry(f'+{self.widget.winfo_rootx()}+{self.widget.winfo_rooty() + self.widget.winfo_height() + 6}')
        text = self.text() if callable(self.text) else self.text
        tk.Label(self.window, text=text, bg='#1e2023', fg='#ffffff', font=UI_FONT,
                 padx=9, pady=5, wraplength=260, justify='left').pack()

    def hide(self, event=None):
        if self.pending is not None:
            self.widget.after_cancel(self.pending)
            self.pending = None
        if self.window is not None:
            self.window.destroy()
            self.window = None


def icon_button(parent, icon, tooltip, command):
    button = ttk.Button(parent, text=ICONS[icon], command=command,
                        style='Icon.TButton', width=2, takefocus=True)
    button.tooltip = ToolTip(button, tooltip)
    return button


def icon_menu(parent, icon, tooltip):
    button = ttk.Button(parent, text=ICONS[icon], style='Icon.TButton', width=2,
                        takefocus=False, cursor='hand2')
    menu = DarkPopupMenu(button, PALETTES['深色'])
    button.configure(command=menu.post)
    button.tooltip = ToolTip(button, tooltip)
    return button, menu


class DarkPopupMenu:
    """Borderless, dark popup menu for the downloader's overflow control."""
    def __init__(self, owner, colors):
        self.owner = owner
        self.root_widget = owner.root_widget if isinstance(owner, DarkPopupMenu) else owner.winfo_toplevel()
        self.colors = colors
        self.items = []
        self.popup = None
        self.rows = []
        self._root_menu = self
        self._windows = []
        self._close_job = None
        self._open_job = None
        self._children = []

    def add_command(self, *, label, command):
        self.items.append(('command', label, command))

    def add_radiobutton(self, *, label, variable, value, command=None):
        self.items.append(('radio', label, variable, value, command))

    def add_cascade(self, *, label, menu):
        menu._root_menu = self._root_menu
        menu.colors = self.colors
        self.items.append(('cascade', label, menu))
        self._children.append(menu)

    def add_separator(self):
        self.items.append(('separator',))

    def post(self):
        self._root_menu._close()
        self._root_menu = self
        self._windows = []
        x = self.owner.winfo_rootx()
        y = self.owner.winfo_rooty() + self.owner.winfo_height()
        self._show_at(x, y)
        self.popup.bind('<Escape>', lambda _event: self._root_menu._close())
        self.popup.focus_force()

    def _show_at(self, x, y, parent_row=None):
        root = self._root_menu
        popup = tk.Toplevel(self.root_widget)
        popup.overrideredirect(True)
        popup.transient(self.root_widget)
        popup.configure(bg=self.colors['bg'])
        self.popup = popup
        self.rows = []
        root._windows.append((popup, self))
        for index, item in enumerate(self.items):
            kind = item[0]
            if kind == 'separator':
                line = tk.Frame(popup, height=1, bg=self.colors['border'])
                line.pack(fill='x', padx=8, pady=4)
                continue
            row = tk.Frame(popup, bg=self.colors['bg'], padx=9, pady=5, cursor='hand2')
            row.pack(fill='x')
            self.rows.append((index, row))
            label = item[1]
            marker = ''
            if kind == 'radio':
                marker = '●  ' if str(item[2].get()) == str(item[3]) else '○  '
            elif kind == 'cascade':
                marker = '›'
            text = tk.Label(row, text=f'{marker}{label}', anchor='w',
                            bg=self.colors['bg'], fg=self.colors['fg'],
                            font=UI_FONT, padx=1, pady=0, cursor='hand2')
            text.pack(side='left', fill='x', expand=True)
            if kind == 'cascade':
                text.configure(text=label)
                arrow = tk.Label(row, text='›', bg=self.colors['bg'], fg=self.colors['muted'],
                                 font=UI_FONT, padx=4, cursor='hand2')
                arrow.pack(side='right')
                arrow.bind('<Enter>', lambda _e, i=index: self._hover(i), add='+')
                arrow.bind('<Button-1>', lambda _e, i=index: self._activate(i), add='+')
            row.bind('<Enter>', lambda _e, i=index: self._hover(i), add='+')
            text.bind('<Enter>', lambda _e, i=index: self._hover(i), add='+')
            row.bind('<Button-1>', lambda _e, i=index: self._activate(i), add='+')
            text.bind('<Button-1>', lambda _e, i=index: self._activate(i), add='+')
            row.bind('<Leave>', lambda _e: root._schedule_close(), add='+')
            popup.bind('<Enter>', lambda _e: root._cancel_close(), add='+')
            popup.bind('<Leave>', lambda _e: root._schedule_close(), add='+')
        popup.update_idletasks()
        width = max(196, popup.winfo_reqwidth())
        height = popup.winfo_reqheight()
        screen_w = popup.winfo_screenwidth()
        screen_h = popup.winfo_screenheight()
        x = int(x)
        if parent_row is not None and x + width > screen_w:
            x = parent_row.winfo_rootx() - width
        x = max(0, min(x, screen_w - width))
        y = int(y)
        if parent_row is not None and y + height > screen_h:
            y = parent_row.winfo_rooty() - height
        y = max(0, min(y, screen_h - height))
        popup.geometry(f'{width}x{height}+{x}+{y}')
        popup.update_idletasks()
        popup.lift()

    def _hover(self, index):
        root = self._root_menu
        root._cancel_close()
        if self._open_job is not None and self.popup and self.popup.winfo_exists():
            try:
                self.popup.after_cancel(self._open_job)
            except tk.TclError:
                pass
            self._open_job = None
        self._close_descendants()
        item = self.items[index] if 0 <= index < len(self.items) else None
        if item and item[0] == 'separator':
            item = None
        for row_index, row in self.rows:
            color = self.colors['hover'] if row_index == index else self.colors['bg']
            row.configure(bg=color)
            for child in row.winfo_children():
                child.configure(bg=color)
        if item and item[0] == 'cascade':
            self._open_job = self.popup.after(90, lambda: self._open_cascade(index, item[2]))

    def _open_cascade(self, index, menu):
        self._open_job = None
        if self.popup is None or not self.popup.winfo_exists():
            return
        row = next((row for row_index, row in self.rows if row_index == index), None)
        if row is None:
            return
        menu._root_menu = self._root_menu
        menu.colors = self.colors
        self.popup.update_idletasks()
        row.update_idletasks()
        # Keep settings cascades attached to their row and expand below it.
        # Right-side cascades were clipped by narrow windows and could appear
        # underneath another application window.
        root_popup = self._root_menu.popup
        x = root_popup.winfo_rootx() if root_popup and root_popup.winfo_exists() else self.popup.winfo_rootx()
        y = row.winfo_rooty() + row.winfo_height()
        menu._show_at(x, y, row)

    def _activate(self, index):
        item = self.items[index] if 0 <= index < len(self.items) else None
        if item and item[0] == 'separator':
            item = None
        if not item:
            return
        if item[0] == 'cascade':
            self._open_cascade(index, item[2])
        elif item[0] == 'radio':
            _, _, variable, value, command = item
            variable.set(value)
            self._root_menu._close()
            if command:
                self.root_widget.after_idle(command)
        else:
            self._root_menu._close()
            self.root_widget.after_idle(item[2])

    def _close_descendants(self):
        root = self._root_menu
        def close_tree(menu):
            for item in menu.items:
                if item[0] == 'cascade':
                    close_tree(item[2])
            if menu is not self and menu.popup is not None:
                if menu.popup.winfo_exists():
                    menu.popup.destroy()
                menu.popup = None
                root._windows = [(popup, entry) for popup, entry in root._windows if entry is not menu]
        for item in self.items:
            if item[0] == 'cascade':
                close_tree(item[2])

    def _schedule_close(self):
        root = self._root_menu
        root._cancel_close()
        if root.popup and root.popup.winfo_exists():
            root._close_job = root.popup.after(260, root._close_if_pointer_outside)

    def _cancel_close(self):
        root = self._root_menu
        if root._close_job is not None and root.popup and root.popup.winfo_exists():
            try:
                root.popup.after_cancel(root._close_job)
            except tk.TclError:
                pass
            root._close_job = None

    def _close_if_pointer_outside(self):
        root = self._root_menu
        root._close_job = None
        x, y = root.root_widget.winfo_pointerx(), root.root_widget.winfo_pointery()
        for popup, _menu in root._windows:
            if popup.winfo_exists():
                left, top = popup.winfo_rootx(), popup.winfo_rooty()
                if left <= x <= left + popup.winfo_width() and top <= y <= top + popup.winfo_height():
                    return
        root._close()

    def _close(self):
        root = self._root_menu
        root._cancel_close()
        if root._open_job is not None and root.popup and root.popup.winfo_exists():
            try:
                root.popup.after_cancel(root._open_job)
            except tk.TclError:
                pass
            root._open_job = None
        for popup, _menu in reversed(root._windows):
            if popup.winfo_exists():
                popup.destroy()
        root._windows.clear()
        root.popup = None


def style_menu(menu, colors):
    menu.configure(background=colors['bg'], foreground=colors['fg'],
                   activebackground=colors['hover'], activeforeground=colors['fg'],
                   disabledforeground=colors['disabled'], borderwidth=0,
                   activeborderwidth=0, relief='flat', selectcolor=colors['select'])


def bind_scale_wheel(scale, step=1.0):
    """Let a numeric scale be adjusted with the mouse wheel wherever it appears."""
    def adjust(event, direction=None):
        if direction is None:
            if getattr(event, 'num', None) == 4:
                direction = 1
            elif getattr(event, 'num', None) == 5:
                direction = -1
            else:
                delta = getattr(event, 'delta', 0)
                direction = 1 if delta > 0 else -1 if delta < 0 else 0
        if not direction:
            return 'break'
        low = float(scale.cget('from'))
        high = float(scale.cget('to'))
        current = float(scale.get())
        scale.set(max(min(low, high), min(max(low, high), current + direction * step)))
        return 'break'

    scale.bind('<MouseWheel>', adjust, add='+')
    scale.bind('<Button-4>', lambda event: adjust(event, 1), add='+')
    scale.bind('<Button-5>', lambda event: adjust(event, -1), add='+')


def add_theme_menu(menu, variable, command):
    themes = tk.Menu(menu, tearoff=False)
    for name in PALETTES:
        themes.add_radiobutton(label=name, variable=variable, value=name, command=command)
    menu.add_cascade(label='界面主题', menu=themes)


def set_window_icon(window, kind):
    directory = Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'assets'
    icon = directory / f'{kind}.ico'
    if icon.is_file():
        try:
            window.iconbitmap(str(icon))
        except tk.TclError:
            pass


def native_caption(window, colors, dark):
    if os.name != 'nt' or not window.winfo_exists():
        return
    import ctypes
    from ctypes import wintypes
    user = ctypes.WinDLL('user32')
    user.GetParent.argtypes = [wintypes.HWND]
    user.GetParent.restype = wintypes.HWND
    hwnd = user.GetParent(window.winfo_id())
    dwm = ctypes.WinDLL('dwmapi')
    dwm.DwmSetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD,
                                         ctypes.c_void_p, wintypes.DWORD]
    def attribute(number, value):
        data = ctypes.c_int(value)
        dwm.DwmSetWindowAttribute(hwnd, number, ctypes.byref(data), ctypes.sizeof(data))
    def color(value):
        return int(value[5:7] + value[3:5] + value[1:3], 16)
    attribute(20, int(dark))
    attribute(33, 2)
    attribute(35, color(colors['toolbar']))
    attribute(36, color(colors['fg']))


def apply_appearance(root, appearance):
    colors = PALETTES.get(appearance, PALETTES['浅色'])
    style = ttk.Style(root)
    # Keep the clam layout, but own its slider elements so the handle remains
    # visible on both dark and light backgrounds.
    theme_name = 'ClipAssistant'
    theme_created = theme_name not in style.theme_names()
    image_owner = root._root()
    if theme_created:
        style.theme_use('clam')
        style.theme_create(theme_name, parent='clam')
    style.theme_use(theme_name)
    if theme_created:
        from PIL import Image, ImageDraw, ImageTk
        scale_images = []
        for orientation in ('Horizontal', 'Vertical'):
            states = []
            for fill, outline in (('#A6A9AE', '#E0E1E3'), ('#68A9A2', '#9BD1CB'),
                                  ('#8CC8C2', '#D7F0ED'), ('#4B4D51', '#686A70')):
                image = Image.new('RGBA', (14, 14), (0, 0, 0, 0))
                draw = ImageDraw.Draw(image)
                draw.ellipse((2, 2, 11, 11), fill=fill, outline=outline, width=1)
                photo = ImageTk.PhotoImage(image, master=image_owner)
                states.append(photo)
                scale_images.append(photo)
            style.element_create(f'{orientation}.Scale.slider', 'image', states[0],
                                 ('active', states[1]), ('pressed', states[2]),
                                 ('disabled', states[3]), sticky='nsew')
        image_owner._clipassistant_scale_images = scale_images
    if 'ClipAssistant.RoundedButton.border' not in style.element_names():
        from PIL import Image, ImageDraw, ImageTk
        button_fill = colors['button']
        disabled_fill = colors['toolbar']
        images = {}
        image_scale = 4
        resample = Image.Resampling.LANCZOS
        for name, fill in (('normal', button_fill), ('active', colors['hover']),
                           ('pressed', colors['border']),
                           ('disabled', disabled_fill)):
            # Supersample stretchable corners so rounded buttons stay smooth.
            image = Image.new('RGBA', (12 * image_scale, 12 * image_scale), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            # Use a clean, borderless DaVinci-style control. The previous
            # contrast outline made every small toolbar and navigation button
            # look like a boxed tile, especially on the dark downloader page.
            draw.rounded_rectangle((0, 0, 12 * image_scale - 1, 12 * image_scale - 1),
                                   radius=5 * image_scale, fill=fill)
            images[name] = ImageTk.PhotoImage(image.resize((12, 12), resample), master=root)
        primary_images = {}
        for name, top, bottom in (
            ('normal', colors.get('primary', '#f1f1f2'), colors.get('primary_bottom', '#d7d8db')),
            ('active', '#ffffff', '#e5e6e8'),
            ('pressed', '#d0d1d4', '#c5c7cb'),
            ('disabled', disabled_fill, disabled_fill),
        ):
            image = Image.new('RGBA', (12 * image_scale, 12 * image_scale), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            for y in range(12 * image_scale):
                ratio = y / (12 * image_scale - 1)
                color = tuple(round(int(top[i:i+2], 16) * (1-ratio) +
                                    int(bottom[i:i+2], 16) * ratio) for i in (1, 3, 5))
                draw.line((0, y, 12 * image_scale - 1, y), fill=color)
            mask = Image.new('L', (12 * image_scale, 12 * image_scale), 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                (0, 0, 12 * image_scale - 1, 12 * image_scale - 1),
                radius=5 * image_scale, fill=255)
            image.putalpha(mask)
            primary_images[name] = ImageTk.PhotoImage(image.resize((12, 12), resample), master=root)
        style.element_create('ClipAssistant.RoundedButton.border', 'image', images['normal'],
                             ('active', images['active']), ('pressed', images['pressed']),
                             ('disabled', images['disabled']), border=5, sticky='nsew')
        style.element_create('ClipAssistant.PrimaryButton.border', 'image', primary_images['normal'],
                             ('active', primary_images['active']), ('pressed', primary_images['pressed']),
                             ('disabled', primary_images['disabled']), border=5, sticky='nsew')
        root._clipassistant_button_images = images
        root._clipassistant_primary_images = primary_images
        rounded_layout = [('ClipAssistant.RoundedButton.border', {'sticky': 'nsew', 'children': [
            ('Button.padding', {'sticky': 'nsew', 'children': [
                ('Button.label', {'sticky': 'nswe'})]})]})]
        primary_layout = [('ClipAssistant.PrimaryButton.border', {'sticky': 'nsew', 'children': [
            ('Button.padding', {'sticky': 'nsew', 'children': [
                ('Button.label', {'sticky': 'nswe'})]})]})]
        style.layout('TButton', rounded_layout)
        style.layout('TMenubutton', rounded_layout)
        style.layout('Primary.TButton', primary_layout)
        style.layout('Selected.TButton', primary_layout)
    style.configure('.', background=colors['bg'], foreground=colors['fg'],
                    font=UI_FONT, fieldbackground=colors['field'], borderwidth=0,
                    bordercolor=colors['border'], lightcolor=colors['border'],
                    darkcolor=colors['border'], selectbackground=colors['select'],
                    selectforeground='#ffffff', focuscolor=colors['border'])
    style.configure('TButton', padding=(8, 3), relief='flat', background=colors['button'],
                    foreground=colors['fg'], borderwidth=0, font=UI_FONT)
    style.layout('FlatRefresh.TButton', [('Button.label', {'sticky': 'nswe'})])
    style.configure('FlatRefresh.TButton', font=('Segoe UI Symbol', 10), padding=0, relief='flat', anchor='s',
                    background=colors['bg'], foreground=colors['muted'], borderwidth=0,
                    focuscolor=colors['bg'])
    style.map('FlatRefresh.TButton', background=[('disabled', colors['bg']),
                                                  ('pressed', colors['bg']),
                                                  ('active', colors['bg'])],
              foreground=[('disabled', colors['disabled']),
                          ('pressed', colors['fg']), ('active', colors['fg'])])
    style.configure('TMenubutton', padding=(8, 3), relief='flat', background=colors['button'])
    for name in ('TButton', 'TMenubutton'):
        style.map(name, background=[('disabled', colors['bg']), ('pressed', colors['border']),
                                    ('active', colors['hover'])],
                  foreground=[('disabled', colors['disabled']),
                              ('!disabled', colors['fg'])],
                  bordercolor=[('focus', colors['border'])])
    scale_trough = '#202023' if appearance == '深色' else '#d4d8dc'
    style.configure('TScale', background=colors['bg'],
                    troughcolor=scale_trough, bordercolor=scale_trough,
                    lightcolor=scale_trough, darkcolor=scale_trough,
                    sliderlength=18, borderwidth=0, relief='flat',
                    focuscolor=colors['bg'])
    for name in ('Horizontal.TScale', 'Vertical.TScale'):
        style.configure(name, background=colors['bg'],
                        troughcolor=scale_trough, bordercolor=scale_trough,
                        lightcolor=scale_trough, darkcolor=scale_trough,
                        sliderlength=18, borderwidth=0, relief='flat',
                        focuscolor=colors['bg'])
        style.map(name, background=[('disabled', colors.get('disabled', colors['border'])),
                                    ('active', colors['bg']), ('!active', colors['bg'])])
    for name in ('Icon.TButton', 'Icon.TMenubutton'):
        style.configure(name, font=ICON_FONT, padding=(5, 4), background=colors['button'],
                        relief='flat', borderwidth=0)
        style.map(name, background=[('disabled', colors['toolbar']), ('pressed', colors['border']),
                                    ('active', colors['hover'])],
                  foreground=[('disabled', colors['disabled'])],
                  bordercolor=[('focus', colors['border']), ('!focus', colors['border'])])
    style.layout('Icon.TMenubutton', style.layout('TButton'))
    style.configure('Primary.TButton', background=colors.get('primary', colors['button']),
                    foreground=colors.get('primary_fg', colors['fg']),
                    padding=(9, 3), borderwidth=0)
    style.map('Primary.TButton', background=[('disabled', colors['toolbar']),
                                             ('active', colors.get('primary', colors['hover'])), ('pressed', colors['border'])],
               foreground=[('disabled', colors['disabled']),
                           ('!disabled', colors.get('primary_fg', colors['fg']))])
    style.configure('Selected.TButton', background=colors.get('primary', colors['button']),
                    foreground=colors.get('primary_fg', colors['fg']), padding=(8, 3),
                    borderwidth=0, font=UI_FONT)
    for name in ('TEntry', 'TCombobox', 'TSpinbox'):
        style.configure(name, padding=(6, 5), relief='flat', borderwidth=1,
                        arrowsize=12, arrowcolor=colors['muted'])
        style.map(name, fieldbackground=[('readonly', colors['field']), ('disabled', colors['bg'])],
                  foreground=[('disabled', colors['disabled']), ('readonly', colors['fg'])],
                  selectbackground=[('!disabled', colors['select'])],
                  selectforeground=[('!disabled', '#ffffff')],
                  bordercolor=[('focus', colors['border']), ('!focus', colors['border'])])
    style.configure('Cell.TEntry', padding=(5, 5), borderwidth=0,
                    lightcolor=colors['field'], darkcolor=colors['field'])
    style.map('Cell.TEntry', bordercolor=[('focus', colors['border']), ('!focus', colors['field'])])
    style.configure('Path.TEntry', padding=(6, 5), relief='flat', borderwidth=0,
                    fieldbackground=colors['field'], bordercolor=colors['field'],
                    lightcolor=colors['field'], darkcolor=colors['field'])
    style.map('Path.TEntry', bordercolor=[('focus', colors['field']), ('!focus', colors['field'])])
    style.configure('Muted.TLabel', foreground=colors['muted'])
    style.configure('Toolbar.TFrame', background=colors['toolbar'])
    style.configure('Toolbar.TLabel', background=colors['toolbar'])
    style.configure('ToolbarMuted.TLabel', background=colors['toolbar'], foreground=colors['muted'])
    style.configure('Paper.TFrame', background=colors['field'])
    style.configure('TSeparator', background=colors['border'], lightcolor=colors['border'],
                    darkcolor=colors['border'], bordercolor=colors['border'])
    scrollbar_bg = '#101011' if appearance == '深色' else '#e3e5e8'
    scrollbar_thumb = '#4B4D51' if appearance == '深色' else '#8A8D92'
    scrollbar_hover = '#686A70' if appearance == '深色' else '#686B70'
    style.configure('Vertical.TScrollbar', width=9, borderwidth=0,
                    background=scrollbar_thumb, troughcolor=scrollbar_bg,
                    lightcolor=scrollbar_thumb, darkcolor=scrollbar_thumb,
                    bordercolor=scrollbar_bg, relief='flat')
    style.map('Vertical.TScrollbar', background=[('active', scrollbar_hover),
                                                  ('!active', scrollbar_thumb)])
    style.layout('Vertical.TScrollbar', [('Vertical.Scrollbar.trough', {'sticky': 'ns',
                 'children': [('Vertical.Scrollbar.thumb', {'expand': '1', 'sticky': 'nswe'})]})])
    style.configure('Horizontal.TScrollbar', width=9, borderwidth=0,
                    background=scrollbar_thumb, troughcolor=scrollbar_bg,
                    lightcolor=scrollbar_thumb, darkcolor=scrollbar_thumb,
                    bordercolor=scrollbar_bg, relief='flat')
    style.map('Horizontal.TScrollbar', background=[('active', scrollbar_hover),
                                                    ('!active', scrollbar_thumb)])
    style.layout('Horizontal.TScrollbar', [('Horizontal.Scrollbar.trough', {'sticky': 'ew',
                 'children': [('Horizontal.Scrollbar.thumb', {'expand': '1', 'sticky': 'nswe'})]})])
    style.configure('TCheckbutton', padding=2)
    style.map('TCheckbutton', background=[('active', colors['bg'])],
              foreground=[('disabled', colors['disabled']), ('active', colors['fg'])])
    style.configure('Treeview', background=colors['field'], fieldbackground=colors['field'],
                    rowheight=32, borderwidth=0)
    style.configure('Treeview.Heading', padding=(8, 8), background=colors['toolbar'],
                    foreground=colors['muted'], relief='flat')
    style.map('Treeview', background=[('selected', colors['select'])],
              foreground=[('selected', '#ffffff')])
    root.option_add('*TCombobox*Listbox.background', colors['field'])
    root.option_add('*TCombobox*Listbox.foreground', colors['fg'])
    root.option_add('*TCombobox*Listbox.selectBackground', colors['select'])

    def visit(widget):
        if isinstance(widget, (tk.Tk, tk.Toplevel)):
            widget.configure(background=colors['bg'])
            widget.after_idle(lambda w=widget: native_caption(w, colors, appearance == '深色'))
        elif isinstance(widget, tk.Text):
            widget.configure(background=colors['field'], foreground=colors['fg'],
                             insertbackground=colors['fg'], selectbackground=colors['select'],
                             selectforeground='#ffffff', highlightbackground=colors['border'])
        elif isinstance(widget, tk.Menu):
            widget.configure(background=colors['bg'], foreground=colors['fg'],
                             activebackground=colors['hover'], activeforeground=colors['fg'],
                             borderwidth=0, activeborderwidth=0, font=UI_FONT)
        for child in widget.winfo_children():
            visit(child)
    visit(root)


def apply_refresh_button_style(root, appearance='深色'):
    """Refresh the compact column-clear button style for the embedded downloader."""
    colors = PALETTES.get(appearance, PALETTES['深色'])
    style = ttk.Style(root)
    style.layout('FlatRefresh.TButton', [('Button.label', {'sticky': 'nswe'})])
    style.configure('FlatRefresh.TButton', font=('Segoe UI Symbol', 10), padding=0, relief='flat', anchor='s',
                    background=colors['bg'], foreground=colors['muted'], borderwidth=0,
                    focuscolor=colors['bg'])
    style.map('FlatRefresh.TButton', background=[('disabled', colors['bg']),
                                                  ('pressed', colors['bg']),
                                                  ('active', colors['bg'])],
              foreground=[('disabled', colors['disabled']),
                          ('pressed', colors['fg']), ('active', colors['fg'])])
