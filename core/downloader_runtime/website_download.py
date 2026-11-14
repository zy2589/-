"""Direct video-only Tikdown transfer using its public HTML forms."""
from html.parser import HTMLParser
import ipaddress
import os
import socket
import tempfile
from urllib.parse import urljoin, urlparse
import requests
from requests.adapters import HTTPAdapter
from requests.exceptions import ProxyError
from urllib3.util.connection import create_connection

MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024


class _PinnedAddressAdapter(HTTPAdapter):
    """Connect only to an address that passed the public-IP check."""
    def __init__(self, addresses, *args, **kwargs):
        self._addresses = tuple(addresses)
        super().__init__(*args, **kwargs)

    def send(self, request, **kwargs):
        # A proxy resolves the destination itself, so client-side IP pinning
        # cannot guarantee that it connects to the address we validated.
        if kwargs.get('proxies'):
            raise ProxyError('该下载地址启用了网络代理，无法安全固定目标 IP；请关闭代理后重试')
        kwargs['proxies'] = {}
        return super().send(request, **kwargs)

    def get_connection_with_tls_context(self, request, verify, proxies=None, cert=None):
        if proxies and requests.utils.select_proxy(request.url, proxies):
            raise ProxyError('该下载地址启用了网络代理，无法安全固定目标 IP；请关闭代理后重试')
        connection = super().get_connection_with_tls_context(request, verify, proxies={}, cert=cert)
        addresses = self._addresses

        class PinnedConnection(connection.ConnectionCls):
            def _new_conn(self):
                last_error = None
                for address in addresses:
                    try:
                        return create_connection(
                            (address, self.port), self.timeout,
                            source_address=self.source_address,
                            socket_options=self.socket_options)
                    except OSError as exc:
                        last_error = exc
                raise last_error or OSError('无法连接到已验证的公网地址')

        connection.ConnectionCls = PinnedConnection
        return connection


def _public_addresses(url):
    """Return only globally routable IPs, resolving once for connection pinning."""
    parts = urlparse(url)
    if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password:
        raise ValueError('下载链接必须是没有用户信息的 http 或 https 地址')
    host=parts.hostname.rstrip('.').lower()
    if host=='localhost' or host.endswith('.localhost') or host.endswith('.local'):
        raise ValueError('为保护本机网络，不能访问本地地址')
    try:
        addresses={ipaddress.ip_address(host)}
    except ValueError:
        try:
            addresses={ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(host,parts.port or (443 if parts.scheme=='https' else 80),type=socket.SOCK_STREAM)}
        except OSError as exc:
            raise ValueError('无法解析下载链接的服务器地址') from exc
    if not addresses or any(not address.is_global for address in addresses):
        raise ValueError('为保护本机网络，不能访问本地或非公网地址')
    return tuple(str(address) for address in addresses)


def is_tiktok(url):
    host=(urlparse(url).hostname or '').lower()
    return host=='tiktok.com' or host.endswith('.tiktok.com')


def validate_public_http_url(url):
    """Reject redirects to local, private, or otherwise non-public addresses."""
    _public_addresses(url)
    return url


def checked_get(session,url,*,stream=False,timeout=(20,60),max_redirects=5):
    """Follow redirects manually so each destination is checked before contact."""
    current=url
    for _ in range(max_redirects+1):
        addresses=_public_addresses(current)
        adapter=_PinnedAddressAdapter(addresses)
        session.mount('http://',adapter)
        session.mount('https://',adapter)
        response=session.get(current,stream=stream,timeout=timeout,allow_redirects=False)
        if response.status_code not in (301,302,303,307,308):
            return response
        location=response.headers.get('Location')
        response.close()
        if not location:
            raise RuntimeError('下载服务器返回了不完整的跳转响应')
        current=urljoin(current,location)
    raise RuntimeError('下载链接跳转次数过多')


class DownloadForm(HTMLParser):
    def __init__(self):
        super().__init__();self.action=None;self.fields={};self.select=None;self.option=None;self.label='';self.video=None

    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='form' and urlparse(attrs.get('action','')).path.endswith('get.php'):self.action=attrs['action']
        if not self.action:return
        if tag=='input' and attrs.get('name'):self.fields[attrs['name']]=attrs.get('value','')
        if tag=='select':self.select=attrs.get('name')
        if tag=='option':self.option=attrs.get('value');self.label=''

    def handle_data(self,data):
        if self.option is not None:self.label+=data

    def handle_endtag(self,tag):
        if tag=='option':
            label=' '.join(self.label.lower().split())
            if self.select and self.option and 'video' in label and ('no watermark' in label or 'without watermark' in label):
                self.video=(self.select,self.option)
            self.option=None


def download_tiktok(url,target,cancel,progress):
    if not is_tiktok(url):raise ValueError('不是 TikTok 视频链接')
    with requests.Session() as session:
        session.headers['User-Agent']='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'
        response=session.post('https://tikdown.net/download.php',data={'URLT':url},timeout=(20,60),allow_redirects=False)
        response.raise_for_status()
        if cancel.is_set():raise RuntimeError('任务已取消')
        form=DownloadForm();form.feed(response.text)
        if not form.action or not form.video:raise RuntimeError('Tikdown 未返回无水印视频, 请检查链接是否可播放或稍后重试')
        endpoint=urljoin(response.url,form.action)
        if (urlparse(endpoint).hostname or '').lower() not in ('tikdown.net','www.tikdown.net') or urlparse(endpoint).scheme!='https':raise RuntimeError('Tikdown 返回了未知下载页面')
        fields=dict(form.fields);fields[form.video[0]]=form.video[1]
        target=os.fspath(target)
        target_dir=os.path.dirname(target) or '.'
        partial=None
        try:
            with checked_get(session,requests.Request('GET',endpoint,params=fields).prepare().url,stream=True,timeout=(20,90)) as media:
                media.raise_for_status()
                total=int(media.headers.get('Content-Length') or 0)
                if total>MAX_VIDEO_BYTES:raise RuntimeError('视频超过单文件 2 GiB 下载上限')
                fd,partial=tempfile.mkstemp(prefix='.video-download-',suffix='.part',dir=target_dir)
                done=0;prefix=bytearray()
                with os.fdopen(fd,'wb') as output:
                    for chunk in media.iter_content(262144):
                        if cancel.is_set():raise RuntimeError('任务已取消')
                        if not chunk:continue
                        if len(prefix)<64:prefix.extend(chunk[:64-len(prefix)])
                        done+=len(chunk)
                        if done>MAX_VIDEO_BYTES:raise RuntimeError('视频超过单文件 2 GiB 下载上限')
                        output.write(chunk);progress(done,total)
                    output.flush();os.fsync(output.fileno())
            if done<32 or b'ftyp' not in prefix[:64]:raise RuntimeError('网站未返回有效或完整的 MP4 视频')
            if total and done!=total:raise RuntimeError('视频传输不完整，收到的数据长度与服务器声明不符')
            os.replace(partial,target);partial=None
        finally:
            if partial and os.path.exists(partial):os.unlink(partial)
    return target
