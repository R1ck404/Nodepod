import type { RequestProxy } from "../request-proxy";

export type InspectWaitUntil =
  | "domcontentloaded"
  | "load"
  | "networkidle"
  | { selector: string; timeout?: number };

export interface InspectTarget {
  port: number;
  selector?: string;
  waitUntil?: InspectWaitUntil;
  timeout?: number;
}

export interface InspectResult<T> {
  port: number;
  url: string;
  capturedAt: number;
  data: T;
  warnings?: string[];
}

export interface InspectAttachOptions { port: number; iframe: HTMLIFrameElement; }
export interface InspectRect { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number; }
export interface InspectConsoleEntry { level: "log" | "info" | "warn" | "error" | "debug"; args: unknown[]; timestamp: number; }
export interface InspectErrorEntry { type: "error" | "rejection"; message: string; stack?: string; url?: string; line?: number; column?: number; timestamp: number; }
export interface InspectDomNode { tag: string; id?: string; class?: string; role?: string; text?: string; rect?: InspectRect; children: InspectDomNode[]; }
export interface InspectQueryNode { selector: string; tag: string; text: string; rect: InspectRect; attributes: Record<string, string>; computed: Record<string, string>; }
export interface InspectA11yNode { role: string; name: string; value?: string; children: InspectA11yNode[]; }
export interface InspectA11yViolation { id: string; impact: "minor" | "moderate"; description: string; nodes: string[]; }
export interface InspectScreenshot { blob: Blob; mimeType: "image/png"; width: number; height: number; }
export type InspectEvent = "console" | "error" | "navigation" | "overflow-change" | "dom-mutation";
export interface InspectSnapshot { viewport?: unknown; documentSize?: unknown; overflow?: unknown; text?: unknown; console?: unknown; errors?: unknown; navigation?: unknown; a11y?: unknown; screenshot?: unknown; }

export class PreviewInspectorError extends Error {}
export class PreviewNotAttachedError extends PreviewInspectorError {}
export class PreviewAgentUnavailableError extends PreviewInspectorError {}
export class PreviewInspectionTimeoutError extends PreviewInspectorError {}
export class PreviewScreenshotUnavailableError extends PreviewInspectorError {}

interface Session { iframe: HTMLIFrameElement; ready: boolean; navigationId: string | null; }
interface WireMessage { __nodepodInspect: 1; v: 1; kind: "ready" | "response" | "event"; instanceId: string; port: number; navigationId?: string; id?: string; event?: InspectEvent; ok?: boolean; data?: any; error?: { code?: string; message: string }; }

const DEFAULT_TIMEOUT = 10_000;

/** Host side of the opt-in, iframe-scoped preview inspection bridge. */
export class PreviewInspector {
  private readonly sessions = new Map<number, Session>();
  private readonly pending = new Map<string, { resolve: (value: InspectResult<any>) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Map<InspectEvent, Set<{ port?: number; handler: (data: unknown) => void }>>();
  private enabled = false;
  private sequence = 0;
  private readonly onMessage = (event: MessageEvent) => this.handleMessage(event);

  constructor(private readonly proxy: RequestProxy, private readonly instanceId: string, private readonly assertActive: () => void) {}

  async enable(): Promise<void> {
    this.assertActive();
    if (!this.enabled && typeof window !== "undefined") window.addEventListener("message", this.onMessage);
    this.enabled = true;
    this.proxy.setPreviewInspectorScript(this.instanceId, PREVIEW_INSPECTOR_AGENT);
  }

  async disable(): Promise<void> {
    this.assertActive();
    this.enabled = false;
    this.proxy.setPreviewInspectorScript(this.instanceId, null);
    if (typeof window !== "undefined") window.removeEventListener("message", this.onMessage);
    for (const session of this.sessions.values()) session.ready = false;
    this.rejectPending(new PreviewAgentUnavailableError("Preview inspection was disabled"));
  }

  attach({ port, iframe }: InspectAttachOptions): void {
    this.assertActive();
    if (!this.enabled) throw new PreviewAgentUnavailableError("Call nodepod.inspect.enable() before attaching a preview iframe");
    this.sessions.set(port, { iframe, ready: false, navigationId: null });
  }

  detach(port: number): void {
    this.assertActive();
    this.sessions.delete(port);
    for (const [id, pending] of this.pending) {
      if (id.startsWith(`${port}:`)) { clearTimeout(pending.timer); pending.reject(new PreviewNotAttachedError(`Preview on port ${port} was detached`)); this.pending.delete(id); }
    }
  }

  ports(): Array<{ port: number; url: string | null; connected: boolean; lastSeen?: number }> {
    this.assertActive();
    return [...this.sessions.entries()].map(([port, session]) => ({ port, url: session.iframe.src || null, connected: session.ready }));
  }

  on(event: InspectEvent, options: { port?: number } | ((data: unknown) => void), maybeHandler?: (data: unknown) => void): () => void {
    this.assertActive();
    const port = typeof options === "function" ? undefined : options.port;
    const handler = typeof options === "function" ? options : maybeHandler;
    if (!handler) throw new TypeError("An inspection event handler is required");
    let set = this.listeners.get(event); if (!set) this.listeners.set(event, set = new Set());
    const entry = { port, handler }; set.add(entry);
    return () => set?.delete(entry);
  }

  viewport(target: InspectTarget) { return this.call(target, "viewport"); }
  documentSize(target: InspectTarget) { return this.call(target, "documentSize"); }
  overflow(target: InspectTarget) { return this.call(target, "overflow"); }
  text(target: InspectTarget & { visibleOnly?: boolean }) { return this.call(target, "text"); }
  dom(target: InspectTarget & { maxDepth?: number; maxNodes?: number }) { return this.call(target, "dom"); }
  query(target: InspectTarget & { selector: string }) { return this.call(target, "query"); }
  console(target: InspectTarget & { level?: InspectConsoleEntry["level"]; since?: number }) { return this.call<InspectConsoleEntry[]>(target, "console"); }
  errors(target: InspectTarget & { since?: number }) { return this.call<InspectErrorEntry[]>(target, "errors"); }
  navigation(target: InspectTarget) { return this.call(target, "navigation"); }
  a11y(target: InspectTarget & { mode?: "tree" | "violations" }) { return this.call<InspectA11yNode | InspectA11yViolation[]>(target, "a11y"); }
  screenshot(target: InspectTarget & { fullPage?: boolean; scale?: number }) { return this.call<InspectScreenshot>(target, "screenshot"); }
  snapshot(target: InspectTarget & { include: Array<keyof InspectSnapshot> }) { return this.call<InspectSnapshot>(target, "snapshot"); }

  dispose(): void {
    if (typeof window !== "undefined") window.removeEventListener("message", this.onMessage);
    this.enabled = false; this.sessions.clear(); this.listeners.clear();
    this.rejectPending(new PreviewAgentUnavailableError("Nodepod was torn down"));
  }

  private call<T = unknown>(target: InspectTarget, method: string): Promise<InspectResult<T>> {
    this.assertActive();
    if (!this.enabled) return Promise.reject(new PreviewAgentUnavailableError("Call nodepod.inspect.enable() before inspection"));
    const session = this.sessions.get(target.port);
    if (!session) return Promise.reject(new PreviewNotAttachedError(`No preview iframe is attached for port ${target.port}`));
    const timeout = target.timeout ?? DEFAULT_TIMEOUT;
    return new Promise((resolve, reject) => {
      const send = () => {
        const id = `${target.port}:${++this.sequence}`;
        const timer = setTimeout(() => { this.pending.delete(id); reject(new PreviewInspectionTimeoutError(`Timed out waiting for ${method} on port ${target.port}`)); }, timeout);
        this.pending.set(id, { resolve, reject, timer });
        session.iframe.contentWindow?.postMessage({ __nodepodInspect: 1, v: 1, kind: "request", instanceId: this.instanceId, port: target.port, navigationId: session.navigationId, id, method, params: target }, "*");
      };
      if (session.ready) send();
      else {
        const waitId = `${target.port}:ready:${++this.sequence}`;
        const timer = setTimeout(() => { this.pending.delete(waitId); reject(new PreviewAgentUnavailableError(`The preview agent is unavailable for port ${target.port}; enable and attach before navigating the iframe, then reload it`)); }, timeout);
        this.pending.set(waitId, { resolve: () => { clearTimeout(timer); send(); }, reject, timer });
      }
    });
  }

  private handleMessage(event: MessageEvent): void {
    const msg = event.data as WireMessage;
    if (!msg || msg.__nodepodInspect !== 1 || msg.v !== 1 || msg.instanceId !== this.instanceId) return;
    const session = this.sessions.get(msg.port);
    if (!session || event.source !== session.iframe.contentWindow) return;
    if (msg.kind === "ready") {
      session.ready = true; session.navigationId = msg.navigationId ?? null;
      const prefix = `${msg.port}:ready:`;
      for (const [id, pending] of this.pending) if (id.startsWith(prefix)) { this.pending.delete(id); pending.resolve({ port: msg.port, url: "", capturedAt: Date.now(), data: undefined }); }
      return;
    }
    if (msg.navigationId && session.navigationId && msg.navigationId !== session.navigationId) return;
    if (msg.kind === "response" && msg.id) {
      const pending = this.pending.get(msg.id); if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.ok) pending.resolve(msg.data); else {
        const error = msg.error?.code === "SCREENSHOT_UNAVAILABLE" ? new PreviewScreenshotUnavailableError(msg.error.message) : new PreviewInspectorError(msg.error?.message ?? "Preview inspection failed");
        pending.reject(error);
      }
    } else if (msg.kind === "event" && msg.event) {
      for (const entry of this.listeners.get(msg.event) ?? []) if (entry.port === undefined || entry.port === msg.port) entry.handler(msg.data);
    }
  }

  private rejectPending(error: Error): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
}

// Deliberately self-contained: the service worker injects this into preview HTML.
const PREVIEW_INSPECTOR_AGENT = String.raw`(function(){
  var cfg=window.__nodepodInspectConfig;if(!cfg||window.__nodepodInspectAgent)return;window.__nodepodInspectAgent=1;try{delete window.__nodepodInspectConfig}catch(_){}
  var nav=Math.random().toString(36).slice(2), consoles=[], errors=[], max=200, inFlight=0, lastNetwork=Date.now(), mutationTimer=0;
  function push(a,v){a.push(v);if(a.length>max)a.shift()}
  function simple(v,seen){seen=seen||[];if(v==null||typeof v==='string'||typeof v==='number'||typeof v==='boolean')return v;if(v instanceof Error)return {name:v.name,message:v.message,stack:v.stack};if(typeof v==='function')return '[Function '+(v.name||'anonymous')+']';if(typeof v!=='object')return String(v);if(seen.indexOf(v)>=0)return '[Circular]';seen.push(v);if(v.nodeType)return '[Node '+(v.nodeName||'')+']';if(Array.isArray(v))return v.slice(0,20).map(function(x){return simple(x,seen)});var o={},n=0;try{Object.keys(v).slice(0,20).forEach(function(k){o[k]=simple(v[k],seen);n++})}catch(_){return String(v)}return o}
  function rect(el){var r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left}}
  function send(kind,p){parent.postMessage(Object.assign({__nodepodInspect:1,v:1,kind:kind,instanceId:cfg.instanceId,port:cfg.port,navigationId:nav},p||{}),'*')}
  ['log','info','warn','error','debug'].forEach(function(level){var old=console[level];console[level]=function(){var e={level:level,args:Array.prototype.map.call(arguments,function(x){return simple(x)}),timestamp:Date.now()};push(consoles,e);send('event',{event:'console',data:e});return old&&old.apply(console,arguments)}});
  addEventListener('error',function(e){var x={type:'error',message:e.message||'Unknown error',stack:e.error&&e.error.stack,url:e.filename,line:e.lineno,column:e.colno,timestamp:Date.now()};push(errors,x);send('event',{event:'error',data:x})});
  addEventListener('unhandledrejection',function(e){var r=e.reason,x={type:'rejection',message:r&&r.message||String(r),stack:r&&r.stack,timestamp:Date.now()};push(errors,x);send('event',{event:'error',data:x})});
  var oldFetch=window.fetch;if(oldFetch)window.fetch=function(){inFlight++;return oldFetch.apply(this,arguments).finally(function(){inFlight--;lastNetwork=Date.now()})};
  var oldOpen=XMLHttpRequest.prototype.open,oldSend=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(){this.__npInspect=1;return oldOpen.apply(this,arguments)};XMLHttpRequest.prototype.send=function(){if(this.__npInspect){inFlight++;this.addEventListener('loadend',function(){inFlight--;lastNetwork=Date.now()},{once:true})}return oldSend.apply(this,arguments)};
  addEventListener('load',function(){send('event',{event:'navigation',data:navigation()})});
  new MutationObserver(function(){if(mutationTimer)return;mutationTimer=setTimeout(function(){mutationTimer=0;send('event',{event:'dom-mutation',data:{timestamp:Date.now()}});send('event',{event:'overflow-change',data:overflow({})})},100)}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  function selected(p){if(!p.selector)return document.body;var e=document.querySelector(p.selector);if(!e)throw Error('Selector not found: '+p.selector);return e}
  function visible(e){var s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0}
  function viewport(){return {innerWidth:innerWidth,innerHeight:innerHeight,outerWidth:outerWidth,outerHeight:outerHeight,devicePixelRatio:devicePixelRatio,scrollX:scrollX,scrollY:scrollY}}
  function documentSize(){var e=document.documentElement;return {scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,clientWidth:e.clientWidth,clientHeight:e.clientHeight}}
  function overflow(p){var root=selected(p),out=[];[root].concat(Array.prototype.slice.call(root.querySelectorAll('*'))).forEach(function(e){if(e.scrollWidth>e.clientWidth||e.scrollHeight>e.clientHeight)out.push({selector:e.id?'#'+CSS.escape(e.id):e.tagName.toLowerCase(),rect:rect(e),scrollSize:{width:e.scrollWidth,height:e.scrollHeight},clientSize:{width:e.clientWidth,height:e.clientHeight},overflows:[].concat(e.scrollWidth>e.clientWidth?'x':[],e.scrollHeight>e.clientHeight?'y':[])})});return {elements:out}}
  function text(p){var e=selected(p),nodes=[e].concat(Array.prototype.slice.call(e.querySelectorAll('*'))),chunks=nodes.filter(function(n){return !p.visibleOnly||visible(n)}).map(function(n){return {selector:n.id?'#'+CSS.escape(n.id):n.tagName.toLowerCase(),text:(n.childElementCount?'' : (n.innerText||'').trim()),visible:visible(n)}}).filter(function(n){return n.text});return {text:chunks.map(function(x){return x.text}).join('\n'),chunks:chunks}}
  function dom(p){var count=0,depth=p.maxDepth==null?8:p.maxDepth,maxNodes=p.maxNodes==null?500:p.maxNodes;function visit(e,d){if(count++>=maxNodes)return {tag:'truncated',children:[]};var n={tag:e.tagName.toLowerCase(),id:e.id||undefined,class:e.className&&typeof e.className==='string'?e.className:undefined,role:e.getAttribute('role')||undefined,text:(e.childElementCount?'':(e.innerText||'').trim().slice(0,200))||undefined,rect:rect(e),children:[]};if(d<depth)Array.prototype.forEach.call(e.children,function(c){n.children.push(visit(c,d+1))});return n}return visit(selected(p),0)}
  function query(p){return Array.prototype.slice.call(document.querySelectorAll(p.selector)).map(function(e){var s=getComputedStyle(e),attrs={};Array.prototype.forEach.call(e.attributes,function(a){attrs[a.name]=a.value});return {selector:p.selector,tag:e.tagName.toLowerCase(),text:(e.innerText||'').trim(),rect:rect(e),attributes:attrs,computed:{display:s.display,visibility:s.visibility,overflow:s.overflow,overflowX:s.overflowX,overflowY:s.overflowY}}})}
  function role(e){return e.getAttribute('role')||({A:'link',BUTTON:'button',INPUT:e.type==='checkbox'?'checkbox':e.type==='radio'?'radio':'textbox',SELECT:'combobox',TEXTAREA:'textbox',IMG:'img',NAV:'navigation',MAIN:'main',HEADER:'banner',FOOTER:'contentinfo'}[e.tagName]||'generic')}
  function name(e){return e.getAttribute('aria-label')||e.getAttribute('alt')||e.labels&&Array.prototype.map.call(e.labels,function(l){return l.innerText}).join(' ')||(e.innerText||'').trim().slice(0,200)||''}
  function a11y(p){var root=selected(p);if(p.mode==='violations'){var v=[];if(!document.documentElement.lang)v.push({id:'html-lang',impact:'moderate',description:'The document element has no lang attribute',nodes:['html']});Array.prototype.forEach.call(root.querySelectorAll('img'),function(e){if(!e.hasAttribute('alt'))v.push({id:'image-alt',impact:'moderate',description:'Image has no alt attribute',nodes:[e.id?'#'+e.id:'img']})});Array.prototype.forEach.call(root.querySelectorAll('input,textarea,select'),function(e){if(!name(e))v.push({id:'form-label',impact:'moderate',description:'Form control has no accessible name',nodes:[e.id?'#'+e.id:e.tagName.toLowerCase()]})});Array.prototype.forEach.call(root.querySelectorAll('button,a[href]'),function(e){if(!name(e))v.push({id:'control-name',impact:'moderate',description:'Interactive control has no accessible name',nodes:[e.id?'#'+e.id:e.tagName.toLowerCase()]})});return v}function walk(e){return {role:role(e),name:name(e),value:e.value||undefined,children:Array.prototype.map.call(e.children,walk)}}return walk(root)}
  function navigation(){var n=performance.getEntriesByType('navigation')[0];return {url:location.href,title:document.title,readyState:document.readyState,referrer:document.referrer,loadEventEnd:n&&n.loadEventEnd||0,inFlight:inFlight,lastNetwork:lastNetwork}}
  function wait(p){var w=p.waitUntil;if(!w||w==='domcontentloaded'&&document.readyState!=='loading'||w==='load'&&document.readyState==='complete')return Promise.resolve();return new Promise(function(resolve,reject){var end=Date.now()+(p.timeout||10000),timer=setInterval(function(){var ok=w==='load'?document.readyState==='complete':w==='domcontentloaded'?document.readyState!=='loading':w==='networkidle'?inFlight===0&&Date.now()-lastNetwork>=500:!!document.querySelector(w.selector);if(ok){clearInterval(timer);resolve()}else if(Date.now()>end){clearInterval(timer);reject(Error('Timed out waiting for preview readiness'))}},50)})}
  function styledClone(source){if(source.nodeType!==1)return source.cloneNode(false);var clone=source.cloneNode(false),style=getComputedStyle(source);clone.setAttribute('xmlns','http://www.w3.org/1999/xhtml');for(var i=0;i<style.length;i++){var key=style[i];clone.style.setProperty(key,style.getPropertyValue(key),style.getPropertyPriority(key))}if(source instanceof HTMLInputElement||source instanceof HTMLTextAreaElement)clone.setAttribute('value',source.value);if(source instanceof HTMLCanvasElement){try{var image=document.createElement('img');image.src=source.toDataURL();return image}catch(_){}}for(var j=0;j<source.childNodes.length;j++)clone.appendChild(styledClone(source.childNodes[j]));return clone}
  function screenshot(p){var e=p.fullPage?document.documentElement:selected(p),size=p.fullPage?{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}:{width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height};if(!size.width||!size.height)throw Error('Cannot capture an empty element');var clone=styledClone(e),svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+size.width+'" height="'+size.height+'"><foreignObject width="100%" height="100%">'+new XMLSerializer().serializeToString(clone)+'</foreignObject></svg>';return new Promise(function(resolve,reject){var img=new Image(),canvas=document.createElement('canvas'),scale=Math.max(.1,Math.min(4,p.scale||1));canvas.width=Math.ceil(size.width*scale);canvas.height=Math.ceil(size.height*scale);img.onload=function(){try{var context=canvas.getContext('2d');if(!context)throw Error('Canvas is unavailable');context.scale(scale,scale);context.drawImage(img,0,0,size.width,size.height);canvas.toBlob(function(blob){blob?resolve({blob:blob,mimeType:'image/png',width:canvas.width,height:canvas.height}):reject(Error('Canvas encoding failed'))},'image/png')}catch(e){reject(e)}};img.onerror=function(){reject(Error('Browser could not render the preview DOM to an image; external assets or unsupported CSS may be present'))};img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)})}
  function execute(method,p){if(method==='viewport')return viewport();if(method==='documentSize')return documentSize();if(method==='overflow')return overflow(p);if(method==='text')return text(p);if(method==='dom')return dom(p);if(method==='query')return query(p);if(method==='console')return consoles.filter(function(x){return (!p.level||x.level===p.level)&&(!p.since||x.timestamp>=p.since)});if(method==='errors')return errors.filter(function(x){return !p.since||x.timestamp>=p.since});if(method==='navigation')return navigation();if(method==='a11y')return a11y(p);if(method==='screenshot')return screenshot(p);if(method==='snapshot'){var o={},jobs=(p.include||[]).map(function(k){return Promise.resolve(execute(k,p)).then(function(v){o[k]=v})});return Promise.all(jobs).then(function(){return o})}throw Error('Unknown inspection method: '+method)}
  addEventListener('message',function(e){var m=e.data;if(e.source!==parent||!m||m.__nodepodInspect!==1||m.v!==1||m.kind!=='request'||m.instanceId!==cfg.instanceId||m.port!==cfg.port||m.navigationId&&m.navigationId!==nav)return;Promise.resolve().then(function(){return wait(m.params||{})}).then(function(){return execute(m.method,m.params||{})}).then(function(data){send('response',{id:m.id,ok:true,data:{port:cfg.port,url:location.href,capturedAt:Date.now(),data:data}})},function(err){send('response',{id:m.id,ok:false,error:{code:m.method==='screenshot'?'SCREENSHOT_UNAVAILABLE':'INSPECTION_FAILED',message:err&&err.message||String(err)}})})});
  send('ready',{});
})();`;
