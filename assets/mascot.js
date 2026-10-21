/* Motor de animacao do mascote: createDancer (WebGL + fisica de mola) e createMascot (wrapper).
   Estava duplicado byte a byte nas 4 paginas; agora vive aqui. */
/* Organic dancer engine.
   createDancer({el, sprites, heights, base, rx, surfaceR, anchorBottom, onSay, onKey})
   keys: {p:pose, d:ms, f:0|1, x:(fraction*rx), xTo, y, r(deg), sx, sy, say, gait}
   API: run(keys,{loop}), interrupt(keys,{restart}), xFrac(), destroy(), mode */
function createDancer(o){
  const SPR=o.sprites, HT=o.heights, BASE=o.base||{}, rx=o.rx||(()=>1), R=o.surfaceR||0, AB=o.anchorBottom||0;
  const wrap=o.el, names=Object.keys(HT), clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const cv=document.createElement('canvas'); cv.style.cssText='position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:block;';
  wrap.appendChild(cv);
  let gl=null; try{ gl=cv.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:true}); }catch(e){ gl=null; }
  const dpr=Math.min(2,window.devicePixelRatio||1); let W=1,Hc=1;
  function resize(){ W=Math.max(1,wrap.clientWidth); Hc=Math.max(1,wrap.clientHeight); cv.width=Math.round(W*dpr); cv.height=Math.round(Hc*dpr); if(gl) gl.viewport(0,0,cv.width,cv.height); }
  resize(); window.addEventListener('resize',resize);

  /* ---------- WebGL setup ---------- */
  let prog=null, U={}, tex={}, aUV=null, nIdx=0, domImgs={}, loaded=0, ready=false;
  if(gl){
    try{
      const vs=`attribute vec2 a_uv; uniform vec2 u_canvas,u_size,u_anchor,u_scale,u_hair; uniform float u_rot,u_breath,u_shear,u_t,u_flip; varying vec2 v_uv;
      void main(){
        vec2 uv=a_uv; vec2 p=vec2((uv.x-0.5)*u_size.x,(uv.y-1.0)*u_size.y);
        float ax=abs(uv.x-0.5)*2.0; float w=smoothstep(0.30,0.95,ax)*smoothstep(0.12,0.85,uv.y);
        float wob=sin(u_t*2.7+uv.y*6.0+(uv.x-0.5)*4.0);
        p.x+=(u_hair.x+wob*1.5)*w; p.y+=u_hair.y*w;
        p.y+=u_breath*(1.0-uv.y)*0.6; p.x+=u_shear*(-p.y);
        p*=u_scale; float c=cos(u_rot), s=sin(u_rot); p=vec2(c*p.x-s*p.y, s*p.x+c*p.y);
        vec2 pos=u_anchor+p; gl_Position=vec4(pos.x/u_canvas.x*2.0-1.0, 1.0-pos.y/u_canvas.y*2.0, 0.0, 1.0);
        v_uv=vec2(u_flip>0.5?1.0-uv.x:uv.x, uv.y);
      }`;
      const fs=`precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; uniform float u_alpha;
      void main(){ gl_FragColor=texture2D(u_tex,v_uv)*u_alpha; }`;
      const mk=(t,src)=>{ const s=gl.createShader(t); gl.shaderSource(s,src); gl.compileShader(s); if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      prog=gl.createProgram(); gl.attachShader(prog,mk(gl.VERTEX_SHADER,vs)); gl.attachShader(prog,mk(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(prog);
      if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error('link');
      gl.useProgram(prog);
      ['u_canvas','u_size','u_anchor','u_scale','u_hair','u_rot','u_breath','u_shear','u_t','u_flip','u_tex','u_alpha'].forEach(n=>{ U[n]=gl.getUniformLocation(prog,n); });
      const NX=12, NY=16, uv=[], idx=[];
      for(let j=0;j<=NY;j++) for(let i=0;i<=NX;i++) uv.push(i/NX,j/NY);
      for(let j=0;j<NY;j++) for(let i=0;i<NX;i++){ const a=j*(NX+1)+i, b=a+1, c=a+NX+1, d=c+1; idx.push(a,b,c,b,d,c); }
      aUV=gl.getAttribLocation(prog,'a_uv');
      const vb=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,vb); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(uv),gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV,2,gl.FLOAT,false,0,0);
      const ib=gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(idx),gl.STATIC_DRAW); nIdx=idx.length;
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    }catch(e){ console.warn('WebGL unavailable, using DOM fallback',e); gl=null; }
  }
  /* Fallback em <img>: usado quando nao ha WebGL, quando a GPU recusa a textura
     (ex.: paginas abertas via file://, onde o Chrome trata a imagem como cross-origin)
     ou quando algum sprite nao carrega. Sem isto o mascote simplesmente nunca aparecia,
     porque `ready` so virava true depois que TODAS as texturas subissem. */
  function useDomFallback(reason){
    if(!gl && Object.keys(domImgs).length) return;   // ja esta no fallback
    if(reason) console.warn('[mascot] fallback para <img>:', reason);
    if(gl){ gl=null; tex={}; }
    cv.style.display='none';
    names.forEach(n=>{
      if(domImgs[n]) return;
      const im=document.createElement('img'); im.alt=''; im.src=SPR[n].src;
      im.style.cssText=`position:absolute;left:50%;bottom:${AB}px;height:${HT[n]}px;opacity:0;transform-origin:50% 100%;pointer-events:none;filter:drop-shadow(0 6px 10px rgba(0,0,0,.5));`;
      wrap.appendChild(im); domImgs[n]=im;
    });
    ready=true;
  }

  if(gl){
    names.forEach(n=>{
      const im=new Image();
      im.onload=()=>{
        if(!gl) return;
        try{
          const t=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,t);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
          gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,im);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
          tex[n]=t; if(++loaded===names.length) ready=true;
        }catch(e){ useDomFallback(e && e.message); }
      };
      im.onerror=()=>useDomFallback('sprite nao carregou: '+SPR[n].src);
      im.src=SPR[n].src;
    });
  } else {
    useDomFallback();
  }

  /* ---------- physics ---------- */
  const S={x:0,y:0,rot:0,sx:1,sy:1,vx:0,vy:0,vr:0,vsx:0,vsy:0,hx:0,hxv:0,hy:0,hyv:0};
  const tgt={x:0,y:0,rot:0,sx:1,sy:1};
  const spring=(k,vk,target,K,C,h)=>{ const a=K*(target-S[k])-C*S[vk]; S[vk]+=a*h; S[k]+=S[vk]*h; };
  function physics(dt,sub){
    const h=dt/sub;
    for(let i=0;i<sub;i++){
      spring('x','vx',tgt.x,110,17,h); spring('y','vy',tgt.y,260,17,h); spring('rot','vr',tgt.rot,170,14,h);
      spring('sx','vsx',tgt.sx,320,19,h); spring('sy','vsy',tgt.sy,320,19,h);
      if(S.y>0){ if(S.vy>60){ S.vsy-=Math.min(5,S.vy*0.011); S.vsx+=Math.min(4,S.vy*0.008); } S.y=0; S.vy=0; }   // ground: landing squash
      spring('hx','hxv',clamp(-S.vx*0.05,-16,16),95,6.5,h);     // hair/skirt follow-through (inertia)
      spring('hy','hyv',clamp(-S.vy*0.025,-12,12),95,6.5,h);
    }
  }

  /* ---------- pose cross-dissolve ---------- */
  let cur={p:names[0],f:0}, prev=null, fade=1; const BLEND=0.11;
  function setVariant(p,f){ f=f?1:0; if(cur.p===p&&cur.f===f) return; prev=cur; cur={p:p,f:f}; fade=0; }

  /* ---------- choreography ---------- */
  let endFired=false, keys=[], ki=0, loop=true, queue=[], key=null, keyStart=0, nextAt=0, running=false, T=0; const GAIT=230;
  function applyKey(k,idx){
    const base=(nextAt>0&&T-nextAt<400)?nextAt:T;      // stay on the musical grid; resync if we fell far behind
    key=k; keyStart=base; nextAt=base+k.d; setVariant(k.p,k.f);
    tgt.x=(k.x||0)*rx(); tgt.y=k.y||0; tgt.rot=k.r||0; tgt.sx=k.sx||1; tgt.sy=k.sy||1;
    if(k.say&&o.onSay) o.onSay(k.say,tgt.x); if(o.onKey) o.onKey(idx,k);
  }
  function stepSeq(){
    if(!running) return;
    let guard=0;
    while(T>=nextAt && guard++<4){                     // catch up if a frame was slow (keeps music/timers in sync)
      let k=null, idx=-1;
      if(queue.length) k=queue.shift(); else if(ki<keys.length){ idx=ki; k=keys[ki++]; } else if(loop&&keys.length){ ki=0; idx=0; k=keys[ki++]; }
      if(!k){ if(!loop&&!endFired&&ki>=keys.length&&!queue.length){ endFired=true; if(o.onEnd) o.onEnd(); } break; }
      applyKey(k,idx);
    }
    if(key){
      if(key.xTo!=null){ const u=clamp((T-keyStart)/key.d,0,1); tgt.x=((key.x||0)+(key.xTo-(key.x||0))*u)*rx(); }
      if(key.gait){ const ph=(T-keyStart)/GAIT, s=Math.abs(Math.sin(Math.PI*ph));
        tgt.y=(key.y||0)-9*s; tgt.sy=(key.sy||1)*(1-0.035*(1-s)); tgt.sx=(key.sx||1)*(1+0.02*(1-s)); tgt.rot=(key.r||0)+1.6*Math.sin(Math.PI*ph); }
    }
  }

  /* ---------- drawing ---------- */
  function frameParams(){
    let drop=0, ang=0; if(R){ const xc=clamp(S.x,-R+1,R-1); drop=R-Math.sqrt(R*R-xc*xc); ang=Math.asin(xc/R); }
    const dyn=1+clamp(-S.vy*0.00028,-0.07,0.1);
    return {drop,ang,sy:S.sy*dyn,sx:S.sx/Math.sqrt(dyn),breath:Math.sin(T/1000*1.9),idle:0.012*Math.sin(T/1000*0.9)};
  }
  function drawVar(v,alpha,P){
    const n=v.p, t=tex[n]; if(!t) return; const h=HT[n], w=h*SPR[n].w/SPR[n].h;
    gl.bindTexture(gl.TEXTURE_2D,t);
    gl.uniform2f(U.u_canvas,W,Hc); gl.uniform2f(U.u_size,w,h);
    gl.uniform2f(U.u_anchor,W/2+S.x,Hc-AB+S.y+P.drop+(BASE[n]||0)); gl.uniform2f(U.u_scale,P.sx,P.sy);
    gl.uniform1f(U.u_rot,S.rot*Math.PI/180+P.ang+P.idle); gl.uniform2f(U.u_hair,S.hx*h/204,S.hy*h/204);
    gl.uniform1f(U.u_breath,P.breath); gl.uniform1f(U.u_shear,clamp(-S.vx*0.00012,-0.06,0.06));
    gl.uniform1f(U.u_t,T/1000); gl.uniform1f(U.u_flip,v.f); gl.uniform1f(U.u_alpha,alpha); gl.uniform1i(U.u_tex,0);
    gl.drawElements(gl.TRIANGLES,nIdx,gl.UNSIGNED_SHORT,0);
  }
  function draw(){
    const P=frameParams(), a=fade*fade*(3-2*fade);
    if(gl){
      gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      if(prev&&fade<1) drawVar(prev,1-a,P);
      drawVar(cur,(prev&&fade<1)?a:1,P);
    } else {
      names.forEach(n=>{ domImgs[n].style.opacity=0; });
      const put=(v,al)=>{ const im=domImgs[v.p]; im.style.opacity=al;
        im.style.transform=`translate(calc(-50% + ${S.x}px), ${S.y+P.drop+(BASE[v.p]||0)}px) rotate(${S.rot+P.ang*180/Math.PI}deg) scale(${v.f?-P.sx:P.sx}, ${P.sy})`; };
      if(prev&&fade<1) put(prev,1-a); put(cur,(prev&&fade<1)?a:1);
    }
  }

  let raf=0, last=0, dead=false;
  function frame(ts){
    if(dead) return; raf=requestAnimationFrame(frame);
    if(document.hidden||!ready){ last=ts; return; }
    const dt=Math.min(0.25,Math.max(0.001,(ts-last)/1000||0.016)); last=ts; T+=dt*1000;   // follow real time, even on slow devices
    stepSeq(); let rem=dt; while(rem>1e-6){ const h=Math.min(rem,1/120); physics(h,1); rem-=h; }
    if(prev){ fade=Math.min(1,fade+dt/BLEND); if(fade>=1) prev=null; }
    draw();
  }
  raf=requestAnimationFrame(frame);

  return {
    mode: gl?'webgl':'dom',
    run(k,opt){ endFired=false; keys=k; ki=0; loop=!(opt&&opt.loop===false); queue=[]; running=true; nextAt=0; },
    interrupt(k,opt){ queue=k.slice(); nextAt=0; if(opt&&opt.restart) ki=0; running=true; },
    xFrac(){ return tgt.x/(rx()||1); },
    destroy(){ dead=true; cancelAnimationFrame(raf); window.removeEventListener('resize',resize);
      try{ if(gl){ const e=gl.getExtension('WEBGL_lose_context'); if(e) e.loseContext(); } }catch(err){}
      cv.remove(); Object.values(domImgs).forEach(im=>im.remove()); }
  };
}

/* createMascot({el, sprites, charH, ground, stroll, tap}) -> {react(kind,text), say(text), destroy()}
   kinds: hello cheer dance wow shrug sad roll look */
function createMascot(o){
  const host=o.el, k=o.charH/204, s=v=>v*k, rnd=(a,b)=>a+Math.random()*(b-a);
  const H0={wave:200,cheer:198,run:202,front:204,side:204,back:204,big:206}, H={};
  Object.keys(H0).forEach(n=>{ H[n]=H0[n]*k; });
  host.innerHTML='<div class="m-dancer"></div><div class="m-bubble"></div>';
  const bubble=host.querySelector('.m-bubble'); let bt=null;
  function say(t,ms){ bubble.textContent=t; bubble.classList.add('show'); clearTimeout(bt); bt=setTimeout(()=>bubble.classList.remove('show'),ms||2600); }
  const K=(p,d,x)=>Object.assign({p:p,d:d,f:0,x:0,y:0,r:0,sx:1,sy:1,xTo:null,gait:false,say:null},x||{});
  const M={
    breathe:()=>[K('front',rnd(1800,3400))],
    wave:()=>[K('wave',280,{r:-3}),K('wave',260,{f:1,y:s(-6),r:3}),K('wave',260,{r:-3}),K('wave',260,{f:1,y:s(-6),r:3}),K('front',300)],
    look:()=>[K('side',800,{r:-2}),K('front',300),K('side',800,{f:1,r:2}),K('front',400)],
    hop:()=>[K('front',150,{sy:.92,sx:1.05}),K('cheer',380,{y:s(-24),sy:1.04}),K('front',220,{sy:.94,sx:1.03})],
    shuffle:()=>[K('big',320,{r:-5,x:s(-6)}),K('big',320,{r:5,x:s(6)}),K('big',320,{r:-5,x:s(-6)}),K('front',320)],
    turn:()=>[K('front',250),K('side',250),K('back',500),K('side',250,{f:1}),K('front',300)],
    sway:()=>[K('front',500,{r:-3,x:s(-4)}),K('front',500,{r:3,x:s(4)}),K('front',400)],
    stroll:()=>{ const d=Math.random()<.5?-1:1, X=d*s(80);
      return [K('front',140,{sy:.92,sx:1.05}),K('run',800,{x:0,xTo:X,f:d<0?1:0,gait:true}),K('front',260,{x:X,sy:.94,sx:1.03}),
              K('run',800,{x:X,xTo:0,f:d<0?0:1,gait:true}),K('front',300,{sy:.95,sx:1.03})]; }
  };
  const R={
    hello:()=>[K('wave',280,{r:-3}),K('wave',240,{f:1,y:s(-8),r:3}),K('wave',240,{r:-3,y:s(-3)}),K('wave',240,{f:1,y:s(-8),r:3}),K('front',300,{sy:.97})],
    cheer:()=>[K('front',170,{sy:.9,sx:1.06}),K('cheer',400,{y:s(-30),sy:1.04}),K('cheer',180,{y:s(-3),r:-4}),K('front',180,{sy:.9,sx:1.06}),K('cheer',400,{f:1,y:s(-26),sy:1.04}),K('front',260,{sy:.95,sx:1.03})],
    dance:()=>{ const B=300; return [K('cheer',B,{r:-8,x:s(-8),y:s(-6)}),K('cheer',B,{f:1,r:8,x:s(8),y:s(-16)}),K('cheer',B,{r:-8,x:s(-8),y:s(-6)}),K('cheer',B,{f:1,r:8,x:s(8),y:s(-16)}),
      K('front',B,{x:s(-12),r:-6,y:s(-5)}),K('wave',B,{x:s(-5),y:s(-12)}),K('front',B,{x:s(12),r:6,y:s(-5)}),K('wave',B,{f:1,x:s(5),y:s(-12)}),
      K('big',B,{y:s(-14),sy:1.03}),K('big',B,{f:1,sy:.94,sx:1.05}),K('big',B,{y:s(-14),sy:1.03}),K('front',B,{sy:.92,sx:1.05})]; },
    wow:()=>[K('front',120,{sy:.92,sx:1.05}),K('wave',650,{y:s(-14),r:3,sy:1.03}),K('front',300,{sy:.96})],
    shrug:()=>[K('front',220,{r:-4,sy:.97}),K('front',520,{r:4,sy:.97}),K('front',300)],
    sad:()=>[K('front',260,{sy:.95,r:-3}),K('side',900,{r:-2,sy:.97}),K('front',700,{r:2,sy:.96})],
    roll:()=>[K('front',110,{sy:.93,sx:1.04}),K('wave',240,{y:s(-8),r:-3}),K('front',180)],
    look:()=>[K('side',800,{r:-2}),K('front',300),K('side',800,{f:1,r:2}),K('front',300)]
  };
  function idleSeq(){
    const names=['wave','look','hop','shuffle','turn','sway']; if(o.stroll) names.push('stroll','stroll');
    const out=[]; for(let i=0;i<16;i++){ out.push(...M.breathe()); out.push(...M[names[Math.floor(Math.random()*names.length)]]()); } return out;
  }
  const D=createDancer({el:host.querySelector('.m-dancer'),sprites:o.sprites,heights:H,base:{run:10*k},rx:()=>1,surfaceR:0,anchorBottom:o.ground||0});
  D.run(idleSeq(),{loop:true});
  function react(kind,text,ms){ const f=R[kind]; if(f) D.interrupt(f()); if(text) say(text,ms); }
  if(o.tap) host.addEventListener('pointerdown',()=>react('cheer','Hehe! 😄'));
  return { react, say, mode:D.mode, destroy(){ clearTimeout(bt); D.destroy(); host.innerHTML=''; } };
}
