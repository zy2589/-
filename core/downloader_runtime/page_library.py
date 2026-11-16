"""Manage reusable local traffic-copy templates and their styles."""
import json
import tkinter as tk
from tkinter import ttk, messagebox, filedialog, simpledialog
from pathlib import Path

from page_cache import (read_pages, ordered_page_numbers, page_footer, page_design,
                        read_style, save_style, save_phone, save_footer,
                        save_page_name, save_page_content)
from local_design import LocalEditor
from build_cache_catalog import build
from desktop_ui import PALETTES, apply_appearance, style_menu


class PageLibrary:
    def __init__(self, app):
        self.app=app
        self.path=app.cache_path
        self.window=tk.Toplevel(app.root)
        self.window.title('引流模板管理')
        screen_w=self.window.winfo_screenwidth();screen_h=self.window.winfo_screenheight()
        width=min(1160,max(820,screen_w-64));height=min(900,max(620,screen_h-80))
        self.window.geometry(f'{width}x{height}+{max(0,(screen_w-width)//2)}+{max(0,(screen_h-height)//2)}')
        self.window.minsize(min(820,width),min(620,height))
        self.window.transient(app.root)
        apply_appearance(self.window, '深色')
        colors=PALETTES['深色']
        self.window.bind('<Destroy>',self.close_library,add='+')
        preview_panel=ttk.Frame(self.window,padding=8)
        if width < 1120:
            preview_panel.pack(side='bottom',fill='x')
        else:
            preview_panel.pack(side='right',fill='y')
        ttk.Label(preview_panel,text='实时预览 (绿色背景仅预览)').pack(anchor='w',pady=8)
        self.preview=ttk.Label(preview_panel,text='正在生成预览...');self.preview.pack(fill='both',expand=True)
        self.preview_size=(360,240) if height < 760 or width < 1120 else (480,320)
        left=ttk.Frame(self.window,padding=8);left.pack(side='left',fill='y')
        self.listing=tk.Listbox(left,width=22,exportselection=False,background=colors['field'],
                                foreground=colors['fg'],selectbackground=colors['select'],
                                selectforeground='#ffffff',highlightbackground=colors['border'],
                                highlightcolor=colors['border'],highlightthickness=1,
                                borderwidth=0,relief='flat',activestyle='none')
        self.listing.pack(fill='both',expand=True)
        self.tabs=ttk.Notebook(self.window);self.tabs.pack(side='left',fill='both',expand=True,padx=8,pady=8)
        info=ttk.Frame(self.tabs,padding=8);edit=ttk.Frame(self.tabs);self.info_tab=info
        self.tabs.add(info,text='引流文案与号码');self.tabs.add(edit,text='模板样式')
        self.phone=tk.StringVar()
        ttk.Label(info,text='模板中的号码').pack(anchor='w')
        phone_entry=ttk.Entry(info,textvariable=self.phone);phone_entry.pack(fill='x',pady=(2,10))
        self.bind_edit_menu(phone_entry)
        self.template_2_title_var=tk.StringVar()
        self.template_2_title_var.trace_add('write',lambda *_:self.preview_phone() if self.selected==-1 else None)
        self.template_2_title_label=ttk.Label(info,text='模板二标题（对应首页的视频名称）')
        self.template_2_title_entry=ttk.Entry(info,textvariable=self.template_2_title_var)
        self.bind_edit_menu(self.template_2_title_entry)
        self.title_hint=ttk.Label(info,text='模板 2 底部固定显示 LINK IN MY BIO。')
        self.title_hint.pack(anchor='w',pady=(0,8))
        self.config_path=Path(getattr(app,'settings_path',self.path.parent/'settings.json')).parent/'graphic-template-2.json'
        self.template_1_config=self.config_path.with_name('graphic-template-1.json')
        self.promo_scale=tk.IntVar(value=100);self.promo_padding=tk.IntVar(value=49)
        self.promo_scale.trace_add('write',lambda *_:self.preview_phone())
        self.promo_padding.trace_add('write',lambda *_:self.preview_phone())
        self.copy_label=ttk.Label(info,text='引流文案（首页填写的号码会替换文案中的号码）')
        self.copy_label.pack(anchor='w',pady=8)
        self.text=tk.Text(info,wrap='word',height=18,undo=True,exportselection=False,
                          background=colors['field'],foreground=colors['fg'],
                          insertbackground=colors['fg'],selectbackground=colors['select'],
                          selectforeground='#ffffff',highlightbackground=colors['border'],
                          highlightcolor=colors['primary'],highlightthickness=1,
                          borderwidth=0,relief='flat')
        self.text.pack(fill='both',expand=True)
        self.bind_edit_menu(self.text)
        save_row=ttk.Frame(info);save_row.pack(anchor='w',pady=5)
        ttk.Button(save_row,text='保存引流模板',command=self.save_content).pack(side='left',padx=(0,4))
        self.notice=ttk.Label(info,wraplength=650);self.notice.pack(fill='x',pady=8)
        info.bind('<Configure>',lambda e:self.notice.configure(wraplength=max(100,e.width-20)))
        self.editor=LocalEditor(edit,self.path.parent,app.base,embedded=True,on_save=self.save_global,
                                resolution=app.resolution,preview_target=self.preview,
                                preview_size=self.preview_size)
        self.template2_style_panel=ttk.Frame(edit,padding=18)
        ttk.Label(self.template2_style_panel,text='模板 2 引流框样式',font=('Segoe UI',14,'bold')).pack(anchor='w',pady=(0,8))
        ttk.Label(self.template2_style_panel,text='调整引流字与金属底板的比例。右侧预览会即时更新，保存后用于后续生成。',wraplength=600).pack(anchor='w',pady=(0,16))
        self.settings_row=ttk.Frame(self.template2_style_panel)
        ttk.Label(self.settings_row,text='引流文字缩放').pack(side='left')
        ttk.Spinbox(self.settings_row,from_=70,to=150,increment=5,width=7,textvariable=self.promo_scale).pack(side='left',padx=(8,18))
        ttk.Label(self.settings_row,text='%').pack(side='left',padx=(0,24))
        ttk.Label(self.settings_row,text='框内留白').pack(side='left')
        ttk.Spinbox(self.settings_row,from_=15,to=120,increment=2,width=7,textvariable=self.promo_padding).pack(side='left',padx=8)
        ttk.Label(self.settings_row,text='px').pack(side='left')
        self.settings_row.pack(anchor='w',pady=8)
        ttk.Label(self.template2_style_panel,text='说明：数值越大，文字相对底板越大；增加留白会扩大底板。',foreground=colors['muted']).pack(anchor='w',pady=8)
        ttk.Button(self.template2_style_panel,text='保存模板二样式',command=self.save_content).pack(anchor='w',pady=(12,0))
        self.template2_style_panel.pack_forget()
        self.selected=None;self.listing.bind('<<ListboxSelect>>',self.show)
        self.listing.bind('<Button-3>',self.page_menu)
        self.listing.bind('<Double-Button-1>',lambda _:self.edit_content())
        self.reload();self.phone.trace_add('write',lambda *_:self.preview_phone())

    def bind_edit_menu(self,widget):
        def popup(event):
            widget.focus_set();menu=tk.Menu(self.window,tearoff=False);style_menu(menu,PALETTES['深色'])
            for label,action in [('撤销','<<Undo>>'),('剪切','<<Cut>>'),('复制','<<Copy>>'),('粘贴','<<Paste>>'),('全选','<<SelectAll>>')]:
                menu.add_command(label=label,command=lambda action=action:widget.event_generate(action))
            try:menu.tk_popup(event.x_root,event.y_root)
            finally:menu.grab_release()
        widget.bind('<Button-3>',popup)

    def allowed(self):
        if self.app.active:
            messagebox.showinfo('下载进行中','请在这一批下载完成后修改模板。',parent=self.window);return False
        return True

    def position(self,number):return self.numbers.index(number)+1

    def copy_number(self):
        if self.selected is None:return
        self.window.clipboard_clear();self.window.clipboard_append(str(self.position(self.selected)))

    def page_menu(self,event):
        if not self.numbers:return
        index=self.listing.nearest(event.y);self.listing.selection_clear(0,'end');self.listing.selection_set(index)
        if self.selected!=self.numbers[index]:self.show()
        menu=tk.Menu(self.window,tearoff=False);style_menu(menu,PALETTES['深色'])
        menu.add_command(label='复制模板编号',command=self.copy_number)
        menu.add_command(label='编辑引流文案',command=self.edit_content)
        menu.add_command(label='复制模板名称',command=lambda:self.copy_page('name'))
        menu.add_command(label='重命名模板',command=self.rename_page)
        try:menu.tk_popup(event.x_root,event.y_root)
        finally:menu.grab_release()

    def edit_content(self):
        self.tabs.select(self.info_tab)
        (self.phone if self.selected==-1 else self.text).focus_set()

    def reload(self,number=None):
        self.pages=read_pages(self.path)
        source_numbers=ordered_page_numbers(self.pages)
        self.numbers=([source_numbers[0]] if source_numbers else [])
        self.listing.delete(0,'end')
        for position,_ in enumerate(self.numbers,1):self.listing.insert('end',f'模板 {position}')
        if not self.numbers:
            self.selected=None;self.phone.set('');self.text.delete('1.0','end')
            self.notice.configure(text='没有模板，点击“新增模板”建立。');return
        index=self.numbers.index(number) if number in self.numbers else 0
        self.listing.selection_set(index);self.listing.see(index);self.show()

    def show(self,event=None):
        if not self.listing.curselection():return
        number=self.numbers[self.listing.curselection()[0]]
        if event is not None and self.selected==number:return
        self.selected=number
        if number==-1:
            from image_templates import read_template_2,render_template_2
            data=read_template_2(self.config_path)
            title=data.get('title') or self.template_2_title()
            self.phone.set(data['phone']);self.template_2_title_var.set(title);self.promo_scale.set(data['promo_scale']);self.promo_padding.set(data['promo_padding'])
            self.title_hint.pack(anchor='w',pady=(0,8))
            self.template_2_title_label.pack(anchor='w')
            self.template_2_title_entry.pack(fill='x',pady=(2,10))
            self.copy_label.configure(text='模板 2 固定文案（底部固定显示 LINK IN MY BIO）')
            self.text.configure(state='normal')
            self.text.delete('1.0','end')
            self.text.insert('1.0','Message us on Whats/App at\n[模板中的号码]\nto join our FREE online Bible study.\nLINK IN MY BIO')
            self.text.configure(state='disabled')
            self.text.pack(fill='both',expand=True)
            self.notice.configure(text='模板 2 · 可编辑标题与默认号码；标题也会用于首页生成。')
            self.tabs.tab(0,text='号码与固定文案')
            self.tabs.tab(1,text='模板二样式')
            self.tabs.tab(1,state='normal')
            self.editor.style_save_button.configure(text='模板 2 的底图和字效固定')
            self.editor.window.pack_forget()
            self.template2_style_panel.pack(fill='both',expand=True)
            self.tabs.select(self.info_tab)
            self.preview_photo=__import__('PIL.ImageTk',fromlist=['PhotoImage']).PhotoImage(render_template_2(data['phone'],title,preview_size=self.preview_size,settings=data))
            self.preview.configure(image=self.preview_photo,text='')
            return
        page=self.pages[number]
        self.template2_style_panel.pack_forget()
        if not self.editor.window.winfo_manager():self.editor.window.pack(fill='both',expand=True)
        self.tabs.tab(1,state='normal')
        self.tabs.tab(0,text='引流文案与号码')
        self.tabs.tab(1,text='模板样式')
        self.title_hint.pack_forget()
        self.template_2_title_label.pack_forget();self.template_2_title_entry.pack_forget()
        self.copy_label.configure(text='引流文案（首页填写的号码会替换文案中的号码）')
        self.text.configure(state='normal')
        self.text.pack(fill='both',expand=True)
        try:
            footer,source_phone=page_footer(page);phone=self.template_1_phone();self.phone.set(phone)
            design=page_design(self.pages,str(number),self.app.theme.get(),self.app.layout.get(),read_style(self.path))
            design['footer']=design['footer'].replace(source_phone,phone,1);design['phone']=phone
            self.notice.configure(text='模板 1 · 白天：白色底板、黑字、橙色高亮；黑天：黑色底板、白字、黄色高亮。号码按模板独立保存。')
        except ValueError:
            footer='';self.phone.set(self.template_1_phone())
            design={'footer':'','lines':[{'size':52,'bold':True,'runs':[{'text':'标题预览','color':'#000000'}]}],**read_style(self.path)}
            self.notice.configure(text='该模板缺少有效引流文案，请补充文案和带国家区号的号码。')
        self.text.delete('1.0','end');self.text.insert('1.0',footer);self.text.edit_reset();self.text.edit_modified(False)
        self.editor.style_save_button.configure(text='保存当前版本样式' if 'local_style' in page else '保存样式并应用所有模板')
        self.editor.show_design(design)

    def preview_phone(self):
        if self.selected is None:return
        if self.selected==-1:
            from image_templates import render_template_2
            settings={'promo_scale':self.promo_scale.get(),'promo_padding':self.promo_padding.get()}
            self.preview_photo=__import__('PIL.ImageTk',fromlist=['PhotoImage']).PhotoImage(render_template_2(self.phone.get(),self.template_2_title_var.get(),preview_size=self.preview_size,settings=settings))
            self.preview.configure(image=self.preview_photo,text='')
            return
        try:
            design=page_design(self.pages,str(self.selected))
            value=(design['footer'].replace(design['phone'],self.phone.get(),1)
                   if design['phone'] else design['footer'])
            self.editor.design['footer']=value
            self.editor.footer.configure(state='normal');self.editor.footer.delete('1.0','end')
            self.editor.footer.insert('1.0',value);self.editor.footer.edit_modified(False);self.editor.preview()
        except (ValueError,tk.TclError):pass

    def template_2_title(self):
        """Use the current first-page title in the fixed template 2 preview."""
        try:
            from page_cache import page_text,ordered_page_numbers
            pages=read_pages(self.path)
            for number in ordered_page_numbers(pages):
                page=pages[number]
                title='\n'.join(element.get('text','').strip() for element in page.get('text_elements',[])
                                if element.get('type')=='TEXT' and element.get('text','').strip()
                                and element.get('role')!='LOCAL_FOOTER'
                                and 'Message us on' not in element.get('text',''))
                if title:return title
        except (OSError,ValueError,KeyError,TypeError):
            pass
        return '标题预览'

    def save_content(self):
        if not self.allowed() or self.selected is None:return
        try:
            if self.selected==-1:
                from image_templates import save_template_2
                save_template_2(self.config_path,self.phone.get(),self.promo_scale.get(),self.promo_padding.get(),self.template_2_title_var.get())
                self.notice.configure(text='模板 2 的标题、号码、引流字号比例和底板留白已保存。')
                self.preview_phone();return
            save_footer(self.path,self.selected,self.text.get('1.0','end-1c'))
            self.save_template_1_phone(self.phone.get())
            self.catalog();self.reload(self.selected);self.notice.configure(text='引流文案和号码已保存。')
        except Exception as exc:messagebox.showerror('无法保存模板',str(exc),parent=self.window)

    def copy_page(self,kind):
        if self.selected is None:return
        page=self.pages.get(self.selected,{})
        values={'name':f'模板 {self.position(self.selected)}','phone':self.phone.get(),
                'content':self.text.get('1.0','end-1c')}
        value=values.get(kind,'')
        self.window.clipboard_clear();self.window.clipboard_append(value)

    def rename_page(self):
        return

    def template_1_phone(self):
        try:return json.loads(self.template_1_config.read_text(encoding='utf-8')).get('phone','+1(240)726-0061')
        except (OSError,ValueError,TypeError):return '+1(240)726-0061'

    def save_template_1_phone(self,phone):
        from page_cache import format_phone
        import re
        phone=format_phone(phone)
        if not re.fullmatch(r'\+\s*\d[\d ()\-]{6,}\d',phone):raise ValueError('模板号码请包含国家区号')
        self.template_1_config.write_text(json.dumps({'phone':phone},ensure_ascii=False,indent=2),encoding='utf-8')

    def toggle_content_edit(self):
        self.tabs.select(self.info_tab);self.text.focus_set()

    def edit_content(self):
        self.toggle_content_edit()

    def save_page_content(self):
        if not self.allowed() or self.selected in (None,-1):return
        try:
            save_page_content(self.path,self.selected,self.text.get('1.0','end-1c'))
            self.pages=read_pages(self.path);self.notice.configure(text='模板完整文案已保存。')
        except Exception as exc:messagebox.showerror('无法保存模板',str(exc),parent=self.window)

    def save_global(self,design):
        if not self.allowed():raise ValueError('下载期间无法更改模板')
        if self.selected==-1:raise ValueError('模板 2 的底图、字体和位置固定。')
        if self.selected is not None and design.get('footer','').strip():
            save_footer(self.path,self.selected,design['footer']);self.pages=read_pages(self.path);self.catalog()
        if self.selected is not None and 'local_style' in self.pages[self.selected]:
            from page_cache import save_local_style
            save_local_style(self.path,self.selected,design);self.pages=read_pages(self.path)
        else:save_style(self.path,design)
        self.app.layout.set(design.get('layout','自动'))

    def duplicate(self):
        if not self.allowed() or self.selected is None:return
        name=simpledialog.askstring('复制模板','请输入新模板名称：',parent=self.window)
        if not name:return
        try:
            from page_cache import duplicate_page
            source=self.selected
            if source==-1:source=ordered_page_numbers(self.pages)[0]
            number=duplicate_page(self.path,source,name,self.editor.collect())
            self.reload(number);self.catalog()
        except Exception as exc:messagebox.showerror('无法复制模板',str(exc),parent=self.window)

    def add(self):
        if not self.allowed():return
        try:
            from page_cache import add_page
            number=add_page(self.path);self.reload(number);self.catalog()
        except Exception as exc:messagebox.showerror('无法新增模板',str(exc),parent=self.window)

    def delete(self):
        if not self.allowed() or self.selected is None or self.selected==-1:return
        if not messagebox.askyesno('删除模板',f'确定删除模板 {self.selected} 吗？',parent=self.window):return
        try:
            from page_cache import delete_page
            current=self.selected
            delete_page(self.path,current)
            remaining=ordered_page_numbers(read_pages(self.path))
            self.reload(min(remaining,key=lambda n:abs(n-current)) if remaining else None)
            self.catalog()
        except Exception as exc:messagebox.showerror('无法删除模板',str(exc),parent=self.window)

    def restore(self):
        self.reload()

    def catalog(self):
        if getattr(self,'catalog_timer',None) is not None:self.window.after_cancel(self.catalog_timer)
        self.catalog_timer=self.window.after(300,self.write_catalog)

    def write_catalog(self):
        self.catalog_timer=None
        try:build(self.path,self.path.parent/'Canva本地页面信息.html')
        except OSError as exc:self.notice.configure(text=str(exc))

    def close_library(self,event):
        if event.widget!=self.window:return
        timer=getattr(self,'catalog_timer',None)
        if timer is not None:
            try:self.window.after_cancel(timer)
            except tk.TclError:pass
        try:build(self.path,self.path.parent/'Canva本地页面信息.html')
        except OSError:pass
