/* LPMusic: trilha e efeitos gerados via Web Audio. Antes duplicado em 3 paginas. */
/* Galaxy background music (generative, Web Audio). API: LPMusic.setup({vol,button,icon,toggle,persist}), setEnabled(bool), duck(0..1), justStarted() */
const LPMusic=(function(){
  const BPM=92, EIGHTH=60/BPM/2, mf=m=>440*Math.pow(2,(m-69)/12);
  const PROG=[{b:45,p:[57,60,64,67]},{b:41,p:[53,57,60,64]},{b:48,p:[55,60,64,67]},{b:43,p:[55,59,62,64]},
              {b:45,p:[57,60,64,67]},{b:41,p:[53,57,60,64]},{b:50,p:[53,57,62,65]},{b:40,p:[56,59,62,64]}];
  let ctx=null, master=null, noiseBuf=null, nextT=0, step=0, on=true, started=false, just=false, vol=0.35, duckLvl=1, btn=null, ownIcon=false, persist=false;
  const level=()=>on?Math.max(0.0001,vol*duckLvl):0.0001;
  const applyGain=tc=>{ if(master&&ctx) master.gain.setTargetAtTime(level(),ctx.currentTime,tc||0.2); };
  function icon(){ if(btn&&ownIcon) btn.textContent=!started?'🎵':(on?'🔊':'🔇'); }
  function tone(t,midi,dur,type,v){
    const o=ctx.createOscillator(), g=ctx.createGain(); o.type=type; o.frequency.value=mf(midi);
    g.gain.setValueAtTime(0.0001,t); g.gain.exponentialRampToValueAtTime(v,t+0.012); g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t+dur+0.05);
  }
  function play(s,t){
    const bar=Math.floor(s/8)%PROG.length, pos=s%8, ch=PROG[bar], barDur=EIGHTH*8;
    if(pos===0){
      ch.p.forEach(m=>[-7,7].forEach(det=>{
        const o=ctx.createOscillator(), f=ctx.createBiquadFilter(), g=ctx.createGain();
        o.type='sawtooth'; o.frequency.value=mf(m); o.detune.value=det;
        f.type='lowpass'; f.frequency.setValueAtTime(500,t); f.frequency.linearRampToValueAtTime(1500,t+barDur/2); f.frequency.linearRampToValueAtTime(600,t+barDur);
        g.gain.setValueAtTime(0.0001,t); g.gain.linearRampToValueAtTime(0.04,t+0.9); g.gain.setValueAtTime(0.04,t+barDur-0.8); g.gain.linearRampToValueAtTime(0.0001,t+barDur+0.4);
        o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t+barDur+0.5);
      }));
    }
    if(pos===0||pos===4) tone(t,ch.b,EIGHTH*1.8,'sine',0.26);
    if(pos===6) tone(t,ch.b+12,EIGHTH*0.9,'sine',0.09);
    const pat=[0,1,2,3,2,1,3,2], pool=ch.p.map(m=>m+12);
    tone(t,pool[pat[pos]]+((bar%2===1&&pos===7)?12:0),EIGHTH*1.5,'triangle',0.075);
    if(pos===0||pos===4){
      const o=ctx.createOscillator(), g=ctx.createGain(); o.type='sine'; o.frequency.setValueAtTime(120,t); o.frequency.exponentialRampToValueAtTime(42,t+0.16);
      g.gain.setValueAtTime(0.32,t); g.gain.exponentialRampToValueAtTime(0.0001,t+0.2); o.connect(g); g.connect(master); o.start(t); o.stop(t+0.22);
    }
    if(pos%2===1){
      const n=ctx.createBufferSource(); n.buffer=noiseBuf; const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=7500;
      const g=ctx.createGain(); g.gain.setValueAtTime(0.05,t); g.gain.exponentialRampToValueAtTime(0.0001,t+0.05); n.connect(hp); hp.connect(g); g.connect(master); n.start(t);
    }
  }
  function schedule(){
    if(!ctx||ctx.state!=='running'){ if(ctx) nextT=Math.max(nextT,ctx.currentTime+0.1); return; }
    while(nextT<ctx.currentTime+0.4){ play(step,nextT); nextT+=EIGHTH; step++; }
  }
  function init(){
    const C=window.AudioContext||window.webkitAudioContext; if(!C) return false;
    ctx=new C(); master=ctx.createGain(); master.gain.value=0.0001;
    const comp=ctx.createDynamicsCompressor(); master.connect(comp); comp.connect(ctx.destination);
    const dly=ctx.createDelay(1); dly.delayTime.value=EIGHTH*3;
    const fb=ctx.createGain(); fb.gain.value=0.4; const wet=ctx.createGain(); wet.gain.value=0.38;
    const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=2200;
    master.connect(dly); dly.connect(lp); lp.connect(fb); fb.connect(dly); lp.connect(wet); wet.connect(comp);
    const len=Math.floor(ctx.sampleRate*0.06); noiseBuf=ctx.createBuffer(1,len,ctx.sampleRate);
    const d=noiseBuf.getChannelData(0); for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
    applyGain(1.2); nextT=ctx.currentTime+0.15; step=0; setInterval(schedule,100); return true;
  }
  function start(){
    if(started) return; if(!init()) return;
    started=true; just=true; setTimeout(()=>{ just=false; },60); ctx.resume(); icon();
    if(btn) btn.classList.remove('musichint');
  }
  function setEnabled(v){
    on=!!v; applyGain(0.15); icon();
    if(persist){ try{ localStorage.setItem('ludopix_music_off', on?'0':'1'); }catch(e){} }
  }
  document.addEventListener('visibilitychange',()=>{ if(!ctx) return; if(document.hidden) ctx.suspend(); else ctx.resume(); });
  return {
    setup(o){
      o=o||{}; vol=o.vol||vol; btn=o.button||null; ownIcon=!!o.icon; persist=!!o.persist;
      if(persist){ try{ if(localStorage.getItem('ludopix_music_off')==='1') on=false; }catch(e){} }
      ['pointerdown','keydown','touchstart'].forEach(ev=>window.addEventListener(ev,start,{passive:true}));
      if(btn){
        const st=document.createElement('style');
        st.textContent='@keyframes musicHint{0%,100%{box-shadow:0 0 0 0 rgba(45,226,255,.6);}50%{box-shadow:0 0 0 8px rgba(45,226,255,0);}} #muteBtn.musichint{animation:musicHint 1.6s ease-in-out infinite;}';
        document.head.appendChild(st); btn.classList.add('musichint');
        if(o.toggle) btn.addEventListener('click',()=>{ if(just||!started) return; setEnabled(!on); });
      }
      icon();
    },
    setEnabled, duck(f){ duckLvl=f; applyGain(0.35); }, isOn(){ return on; }, justStarted(){ return just; }
  };
})();
