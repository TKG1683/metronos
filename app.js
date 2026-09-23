"use strict";
(function(){
  const $ = s => document.querySelector(s);
  const BPM_MIN=20, BPM_MAX=300;

  // ---- state ----
  let ctx=null, noiseBuf=null;
  let isPlaying=false;
  let targetBPM=120;          // ホーム（設定値）
  let currentBPM=120;         // 実際に鳴っているテンポ
  let beatsPerBar=4, noteValue=4;
  let subdivision=1;          // 1拍を何分割で鳴らすか (1=4分,2=8分,3=3連,4=16分)
  let accents=[2,1,1,1];      // 拍ごとのアクセント: 0=無音 1=通常 2=アクセント(●) 3=強(◎)
  let volume=0.8;
  let soundType='beep';
  let recPct=0.10;           // 1拍ごとに「現在の間隔」を目標との差の何割ぶん戻すか（間隔=秒の空間で補間）
  let autoReturn=false;      // true: 叩くのをやめたら自動で復帰 / false: 握ったまま保持し「ホームへ戻る」で復帰開始（初期値。保存済み設定があればそちら）
  let holding=false;         // 保持中（復帰を止めている）。autoReturn=false でタップすると立つ
  let tapSound=false;        // true: 停止中の測定タップでもクリック音を鳴らす（メトロノームは始めない）
  let steerTaps=[];          // ステアのテンポ算出（直近数タップの移動平均）
  let measureTaps=[];        // 停止中のテンポ測定タップ（performance.now 秒。ctx は停止中に進まないので使わない）
  let measuredBPM=null;      // 測定結果。スタート時にこのテンポから鳴らす（null=未測定）

  // scheduler
  const lookahead=25, aheadTime=0.13;
  let timerID=null;
  let nextNoteTime=0, beatIndex=0, tickInBeat=0;
  let pending=[];             // {t, stop()}
  let visualQueue=[];         // {beat,t,steer}
  let lastTapTime=null;
  let lastBeatT=null, lastBeatIdx=null;  // 直近に「実際に鳴った」拍の時刻と番号（フラム/二重カウント防止＆ステアの拍合わせ用）

  // ---- audio helpers ----
  function ensureCtx(){
    if(!ctx){
      ctx=new (window.AudioContext||window.webkitAudioContext)();
      const len=Math.floor(ctx.sampleRate*0.2);
      noiseBuf=ctx.createBuffer(1,len,ctx.sampleRate);
      const d=noiseBuf.getChannelData(0);
      for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
      ctx.onstatechange=paintAudioState;
    }
    if(ctx.state!=='running') ctx.resume().catch(()=>{});   // iOS は 'interrupted' にもなる
    paintAudioState();
  }
  // オーディオ状態の診断表示（iPad で鳴らないときの切り分け用）
  function paintAudioState(){
    const st=ctx?ctx.state:'none', el=$('#audioState'); if(!el)return;
    el.textContent='オーディオ: '+(st==='none'?'未初期化（スタートかパッドをタップで起動）':st==='running'?'動作中':st==='suspended'?'停止中（画面をタップすると起動）':st==='interrupted'?'中断中（他アプリの音声）':st);
  }

  // ---- iOS のオーディオ解錠 ----
  // iOS Safari は pointerdown(=touchstart) を「ユーザー操作」と見なさず、その中で作った AudioContext は起きない。
  // touchend/click/keydown で確実に resume し、あわせてサイレントモードでも鳴る再生セッションに切り替える。
  let audioUnlocked=false;
  const SILENT_WAV='data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAAA'+'gICA'.repeat(133);
  function unlockAudio(){
    ensureCtx();
    if(audioUnlocked) return;
    try{ if(navigator.audioSession) navigator.audioSession.type='playback'; }catch(e){}   // Safari 17+: サイレントスイッチを無視して鳴らす
    try{                                                                                  // 旧iOS向け: 無音の<audio>を一度再生して再生セッションへ
      const a=document.createElement('audio'); a.setAttribute('playsinline',''); a.src=SILENT_WAV; a.volume=0.01;
      const p=a.play(); if(p&&p.catch) p.catch(()=>{});
    }catch(e){}
    audioUnlocked=true;
  }
  ['touchend','click','keydown'].forEach(t=>document.addEventListener(t,unlockAudio,{capture:true,passive:true}));
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&ctx&&ctx.state!=='running') ctx.resume().catch(()=>{}); });

  // play one click. role: 'strong' | 'accent' | 'beat' | 'sub'  ('mute'は呼び出し側で鳴らさない)
  function click(time, role){
    if(time < ctx.currentTime - 0.005) time = ctx.currentTime;

    const g=ctx.createGain();
    g.connect(ctx.destination);
    let gain = role==='strong'?1.3 : role==='accent'?1.0 : role==='beat'?0.62 : 0.30;
    gain*=volume;

    const env=(a,d)=>{g.gain.setValueAtTime(0.0001,time);g.gain.exponentialRampToValueAtTime(gain,time+a);g.gain.exponentialRampToValueAtTime(0.0001,time+a+d);};

    if(soundType==='beep'){
      const o=ctx.createOscillator();o.type='square';
      o.frequency.value = role==='strong'?1800: role==='accent'?1500: role==='beat'?1000:760;
      env(0.001,0.045); o.connect(g); o.start(time); o.stop(time+0.07);
      pending.push({t:time,stop:()=>{try{o.stop();}catch(e){} g.disconnect();}});
    }else if(soundType==='wood'){
      const o=ctx.createOscillator(),o2=ctx.createOscillator();
      o.type='triangle';o2.type='sine';
      const base= role==='strong'?1650: role==='accent'?1400: role==='beat'?1050:820;
      o.frequency.value=base;o2.frequency.value=base*1.5;
      env(0.0008,0.05);o.connect(g);o2.connect(g);
      o.start(time);o2.start(time);o.stop(time+0.06);o2.stop(time+0.06);
      pending.push({t:time,stop:()=>{try{o.stop();o2.stop();}catch(e){} g.disconnect();}});
    }else if(soundType==='click'){
      const src=ctx.createBufferSource();src.buffer=noiseBuf;
      const bp=ctx.createBiquadFilter();bp.type='bandpass';
      bp.frequency.value= role==='strong'?5000: role==='accent'?4200: role==='beat'?3200:2400;bp.Q.value=1.2;
      env(0.0005,0.03);src.connect(bp);bp.connect(g);
      src.start(time);src.stop(time+0.05);
      pending.push({t:time,stop:()=>{try{src.stop();}catch(e){} g.disconnect();}});
    }else if(soundType==='cowbell'){
      const o=ctx.createOscillator(),o2=ctx.createOscillator();
      o.type='square';o2.type='square';
      const base= role==='strong'?840: role==='accent'?720: role==='beat'?560:500;
      o.frequency.value=base;o2.frequency.value=base*1.5;
      const bp=ctx.createBiquadFilter();bp.type='bandpass';bp.frequency.value=base*1.8;bp.Q.value=2;
      env(0.001,0.09);o.connect(bp);o2.connect(bp);bp.connect(g);
      o.start(time);o2.start(time);o.stop(time+0.12);o2.stop(time+0.12);
      pending.push({t:time,stop:()=>{try{o.stop();o2.stop();}catch(e){} g.disconnect();}});
    }
  }
  // アクセントレベル→役。0(無音)は null（鳴らさない）
  function beatRole(i){ const lv=accents[i]==null?1:accents[i]; return lv===0?null : lv===1?'beat' : lv===2?'accent':'strong'; }
  function defaultAccents(n){ return Array.from({length:n},(_,i)=> i===0?2:1); }
  function resizeAccents(n){ const a=defaultAccents(n); for(let i=0;i<n;i++) if(accents[i]!=null) a[i]=accents[i]; accents=a; }

  function cancelPendingAfter(t){
    const keep=[];
    for(const p of pending){
      if(p.t>t+0.001){ p.stop(); }
      else keep.push(p);
    }
    pending=keep;
    visualQueue=visualQueue.filter(v=>v.t<=t+0.001);
  }
  function prune(){ const now=ctx.currentTime; pending=pending.filter(p=>p.t>now-0.3); }

  // ---- recovery easing toward home ----
  // ---- recovery: 現在の間隔(秒)を、目標との差の recPct ぶんだけ毎拍寄せる ----
  // 比例だけだと終盤が指数的に粘るので、1拍あたり最低 recFloor[BPM] は必ず詰めて有限拍で着地させる
  function applyRecovery(){
    if(holding) return;                   // 握ったまま保持中は戻らない（「ホームへ戻る」で解除）
    const recFloor = 0.5;                 // 1拍あたりの最低詰め量(BPM)。終盤の長い尾を防ぐ
    const Itar = 60/targetBPM;            // 目標の1拍の長さ(秒)
    let I = 60/currentBPM;                // いまの1拍の長さ(秒)
    I += (Itar - I) * recPct;             // まず比例(％)で寄せる
    let bpm = clamp(60/I, BPM_MIN, BPM_MAX);
    const gap = targetBPM - currentBPM;
    if(Math.abs(gap) > 0.05){
      const minStep = Math.min(Math.abs(gap), recFloor);  // 目標は越えない
      if(Math.abs(bpm - currentBPM) < minStep){           // 比例分が小さすぎる終盤
        bpm = currentBPM + Math.sign(gap)*minStep;        // 下限ぶんだけ詰める
      }
    }
    currentBPM = bpm;
    if(Math.abs(currentBPM-targetBPM) < 0.05) currentBPM = targetBPM;
  }

  // ---- scheduler (常時連続。タップが来たら該当拍を差し替える) ----
  function scheduler(){
    while(nextNoteTime < ctx.currentTime + aheadTime){
      const isBeat=(tickInBeat===0);
      if(isBeat){
        const role=beatRole(beatIndex);
        if(role) click(nextNoteTime, role);          // 無音(null)は鳴らさない
        visualQueue.push({beat:beatIndex,t:nextNoteTime,steer:false});
      }else{
        click(nextNoteTime, 'sub');
      }
      advance();
    }
    prune();
    timerID=setTimeout(scheduler,lookahead);
  }
  function advance(){
    tickInBeat++;
    if(tickInBeat>=subdivision){
      tickInBeat=0;
      const wasLast=(beatIndex===beatsPerBar-1);
      beatIndex=(beatIndex+1)%beatsPerBar;
      if(wasLast){                              // 小節の切れ目
        barsElapsed++;
        if(secAuto) maybeAutoAdvance();
      }
      applyRecovery();
    }
    nextNoteTime += (60/currentBPM)/subdivision;
  }
  function maybeAutoAdvance(){
    const s=curSongObj(); if(!s||curSec<0)return;
    const sec=s.sections[curSec]; if(!sec||!sec.bars)return;   // 小節0＝手動のみ
    if(barsElapsed>=sec.bars) nextSection();
  }

  // ---- transport ----
  function start(){
    ensureCtx();
    // 停止中に測定したテンポがあればそこから発車（ステアと同じく、自動復帰ONなら目標へ帰る）。
    // 測定がなければ、一時停止していたテンポ・保持状態のまま再開（ホームにいれば普通のスタート）
    const resuming=isPaused();          // isPlaying を立てる前に判定する
    isPlaying=true;
    if(measuredBPM!=null){ currentBPM=measuredBPM; holding=!autoReturn; }
    else if(!resuming){ currentBPM=targetBPM; holding=false; }
    clearMeasure();
    steerTaps=[]; lastBeatT=null; lastBeatIdx=null; barsElapsed=0;
    beatIndex=0; tickInBeat=0; lastTapTime=null;
    nextNoteTime=ctx.currentTime+0.06;
    pending=[]; visualQueue=[];
    scheduler();
    paintTransport();
    requestWake();
  }
  function stop(){
    isPlaying=false;
    if(timerID){clearTimeout(timerID);timerID=null;}
    for(const p of pending) p.stop();
    pending=[]; visualQueue=[]; lastTapTime=null; steerTaps=[]; lastBeatT=null; lastBeatIdx=null;
    // 一時停止：currentBPM と holding はそのまま残す（スタートで同じテンポから再開）
    clearMeasure();
    clearRing();
    paintTransport();
  }
  function toggle(){ isPlaying?stop():start(); }
  // 停止中に、テンポがホームから離れたまま止まっている＝一時停止状態
  function isPaused(){ return !isPlaying && Math.abs(currentBPM-targetBPM)>=0.5; }
  // ホームに戻して停止（＝従来のストップ）。Space 長押し / X / スタートボタン長押し
  function resetHome(){
    holding=false; currentBPM=targetBPM;
    if(isPlaying) stop(); else { clearMeasure(); paintTransport(); }
  }
  // 「開始/停止」を押した瞬間はいつも通りトグルし、押し続けたら HOLD_MS でリセットを乗せる（反応速度を落とさない）
  let toggleHoldTimer=null;
  function toggleHoldStart(){
    if(toggleHoldTimer!=null) return;
    toggleHoldTimer=setTimeout(()=>{ toggleHoldTimer=null; footFlash(); resetHome(); },HOLD_MS);
  }
  function toggleHoldEnd(){ if(toggleHoldTimer!=null){ clearTimeout(toggleHoldTimer); toggleHoldTimer=null; } }

  // ホームへ戻る（短押し）：保持中 → 復帰開始 / 復帰中 → 一時停止（今のテンポで保持）
  function returnToggle(){
    if(!isPlaying) return;
    if(holding){ holding=false; }
    else if(Math.abs(currentBPM-targetBPM)>=0.05){ holding=true; }
    paintTransport();
  }
  // ホームへ戻る（長押し）：復帰を待たず即座にホームのテンポへ
  function jumpHome(){
    if(!isPlaying) return;
    holding=false; currentBPM=targetBPM;
    paintTransport();
  }
  // 押下→解放で短押し/長押しを振り分ける。画面ボタン・キー（フットスイッチ）共通。
  // AirStep 等のフットスイッチは連打が難しいので、即ホームは長押しに割り当てている
  const HOLD_MS=600;
  let homePressTimer=null, homeLongFired=false;
  function homePressStart(){
    if(homePressTimer!=null) return;                 // 押しっぱなし中の再入は無視
    homeLongFired=false;
    footFlash();
    homePressTimer=setTimeout(()=>{ homePressTimer=null; homeLongFired=true; footFlash(); jumpHome(); },HOLD_MS);
  }
  function homePressEnd(){
    if(homePressTimer!=null){ clearTimeout(homePressTimer); homePressTimer=null; }
    else if(!homeLongFired) return;                  // 対応する押下がない解放（入力欄フォーカス中に押した等）
    if(!homeLongFired) returnToggle();
    homeLongFired=false;
  }

  // ---- steer / tap ----
  function tap(){
    ensureCtx();                          // iOS のオーディオ解錠も兼ねる（停止中でも呼ぶ）

    // 停止中：音は出さず、タップ間隔からテンポを測るだけ。スタートで測ったテンポから鳴り始める
    if(!isPlaying){ measureTap(); return; }

    const now=ctx.currentTime;
    holding=!autoReturn;                  // 自動復帰OFFなら、叩いたテンポを握ったまま保持
    paintTransport();

    // 直前に「実際に鳴った拍」が80ms以内にある＝そのタップは同じ拍 → 吸収（鳴らさず・カウントも進めず、テンポと位相だけ更新）
    if(lastBeatT!=null && lastBeatT<=now && (now-lastBeatT)<0.08){
      steerTempoFromTap(now);
      cancelPendingAfter(now);
      beatIndex=(lastBeatIdx+1)%beatsPerBar;
      tickInBeat=0;
      nextNoteTime=lastBeatT+60/currentBPM;
      lastTapTime=now;
      flashPad(true);
      return;
    }

    // 通常のステアタップ：このタップを「次の拍」として鳴らし、自動側の同拍はキャンセルして差し替える
    steerTempoFromTap(now);
    const bi = (lastBeatIdx!=null) ? (lastBeatIdx+1)%beatsPerBar : beatIndex;
    cancelPendingAfter(now);
    const role=beatRole(bi);
    if(role) click(now+0.001, role);
    lastBeatT=now+0.001; lastBeatIdx=bi;
    visualQueue.push({beat:bi,t:now+0.001,steer:true});
    beatIndex=(bi+1)%beatsPerBar;
    tickInBeat=0;
    nextNoteTime=now+60/currentBPM;       // 叩くのをやめれば、次の拍はここから自動で鳴る（欠けない）
    lastTapTime=now;
    flashPad(true);
  }

  // 停止中の測定：最初のタップから最後のタップまでの全区間を平均（2秒あくと測り直し）
  function measureTap(){
    const now=performance.now()/1000;
    if(tapSound) click(ctx.currentTime+0.001,'beat');   // 設定ONなら叩いた瞬間だけ鳴らす（スケジューラは動かさない）
    if(measureTaps.length && (now-measureTaps[measureTaps.length-1])>2.0){ measureTaps=[]; measuredBPM=null; }
    measureTaps.push(now);
    const n=measureTaps.length;
    if(n>=2){
      const avg=(measureTaps[n-1]-measureTaps[0])/(n-1);
      if(avg>0.15 && avg<2.5) measuredBPM=clamp(60/avg,BPM_MIN,BPM_MAX);
    }
    $('#tapBpm').textContent='測定中 '+n+'打';   // 数値は大きな表示側（frame）に出す。ここは手応えだけ
    flashPad(true);
  }
  function clearMeasure(){ measureTaps=[]; measuredBPM=null; $('#tapBpm').innerHTML='&nbsp;'; }

  // ステアのテンポを直近最大3区間の平均で算出（2秒あくと測り直し）
  function steerTempoFromTap(now){
    if(steerTaps.length && (now-steerTaps[steerTaps.length-1])>2.0) steerTaps=[];
    steerTaps.push(now);
    if(steerTaps.length>4) steerTaps.shift();
    if(steerTaps.length>=2){
      const n=steerTaps.length;
      const avg=(steerTaps[n-1]-steerTaps[0])/(n-1);
      if(avg>0.15 && avg<2.5) currentBPM=clamp(60/avg,BPM_MIN,BPM_MAX);
    }
  }

  // ---- helpers ----
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
  function lerp(a,b,t){return a+(b-a)*t;}
  function mix(c1,c2,t){return `rgb(${Math.round(lerp(c1[0],c2[0],t))},${Math.round(lerp(c1[1],c2[1],t))},${Math.round(lerp(c1[2],c2[2],t))})`;}
  const HOME=[95,194,176], LIVE=[232,154,60];

  function tempoMarking(b){
    if(b<24)return'Larghissimo';if(b<40)return'Grave';if(b<46)return'Largo';
    if(b<52)return'Lento';if(b<56)return'Adagio';if(b<66)return'Adagietto';
    if(b<76)return'Andante';if(b<92)return'Andante moderato';if(b<108)return'Moderato';
    if(b<120)return'Allegretto';if(b<132)return'Allegro';if(b<140)return'Allegro vivace';
    if(b<160)return'Vivace';if(b<176)return'Presto';return'Prestissimo';
  }

  // ---- UI build ----
  const SIGS=[
    {l:'2/4',b:2,n:4},{l:'3/4',b:3,n:4},{l:'4/4',b:4,n:4},
    {l:'5/4',b:5,n:4},{l:'6/8',b:6,n:8},{l:'7/8',b:7,n:8},{l:'3/8',b:3,n:8},{l:'拍なし',b:1,n:4}
  ];
  const SUBS=[{l:'4分',v:1},{l:'8分',v:2},{l:'3連符',v:3},{l:'16分',v:4}];
  const SOUNDS=[{l:'電子',v:'beep'},{l:'ウッド',v:'wood'},{l:'クリック',v:'click'},{l:'カウベル',v:'cowbell'}];

  function buildChips(){
    const sc=$('#sigChips');
    SIGS.forEach(s=>{const b=document.createElement('button');b.className='chip';b.textContent=s.l;
      b.onclick=()=>{beatsPerBar=s.b;noteValue=s.n;resizeAccents(beatsPerBar);refreshSig();renderRing();};sc.appendChild(b);});
    const ub=$('#subChips');
    SUBS.forEach(s=>{const b=document.createElement('button');b.className='chip';b.textContent=s.l;b.dataset.v=s.v;
      b.onclick=()=>{subdivision=s.v;refreshSub();};ub.appendChild(b);});
    const od=$('#soundChips');
    SOUNDS.forEach(s=>{const b=document.createElement('button');b.className='chip';b.textContent=s.l;b.dataset.v=s.v;
      b.onclick=()=>{soundType=s.v;refreshSound(); if(ctx) click(ctx.currentTime+0.02,'beat');};od.appendChild(b);});
  }

  // ---- persistence: localStorageが使えれば永続。使えない環境(プレビュー等)ではメモリ内のみ ----
  const Store=(()=>{
    let ok=false, mem={};
    try{ localStorage.setItem('__sm_t','1'); localStorage.removeItem('__sm_t'); ok=true; }catch(e){ ok=false; }
    return {
      ok,
      get(k,def){ if(!ok) return (k in mem)?mem[k]:def; try{const v=localStorage.getItem(k);return v==null?def:JSON.parse(v);}catch(e){return def;} },
      set(k,v){ if(!ok){ mem[k]=v; return; } try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
    };
  })();
  const SL_KEY='metronos_project_v2';
  const PREF_KEY='metronos_prefs_v1';
  function persistPrefs(){ Store.set(PREF_KEY,{autoReturn,tapSound,keymap}); }
  function loadPrefs(){
    const p=Store.get(PREF_KEY,null); if(!p)return;
    if(p.autoReturn!=null) autoReturn=!!p.autoReturn;
    if(p.tapSound!=null) tapSound=!!p.tapSound;
    if(p.keymap&&typeof p.keymap==='object') for(const a of ACTIONS){ const b=p.keymap[a.id]; if(b&&typeof b.key==='string') keymap[a.id]={key:b.key,code:b.code||''}; }
  }

  // ---- key bindings（フットスイッチ = Bluetooth HID キーボード）----
  // AirStep 等が何のキーを送るかは設定次第なので、MIDI と同じく「学習」で割り当てられるようにする
  const ACTIONS=[
    {id:'steer', l:'タップテンポ（拍を踏む）',    def:{key:'t',code:'KeyT'}},
    {id:'toggle',l:'開始 / 停止（長押しでホームに戻して停止）', def:{key:' ',code:'Space'}},
    {id:'reset', l:'ホームに戻して停止',          def:{key:'x',code:'KeyX'}},   // 長押しを送れないフットスイッチ用
    {id:'next',  l:'次のセクション / 曲',         def:{key:'n',code:'KeyN'}},
    {id:'prev',  l:'前のセクション / 曲',         def:{key:'p',code:'KeyP'}},
    {id:'home',  l:'ホームへ戻る',                def:{key:'r',code:'KeyR'}},
    {id:'jump',  l:'即ホーム（復帰を待たない）',  def:{key:'h',code:'KeyH'}},   // AirStep 等は長押しを送れないので単押しでも用意
    {id:'auto',  l:'自動復帰 ON/OFF',             def:{key:'a',code:'KeyA'}},
    {id:'stage', l:'ステージ表示',                def:{key:'s',code:'KeyS'}},
  ];
  let keymap={}; ACTIONS.forEach(a=>keymap[a.id]={...a.def});
  let keyLearn=null;          // 学習待ちのアクションid
  const keyLabel=b=>!b?'—':(b.key===' '?'Space':(b.key.length===1?b.key.toUpperCase():(b.code||b.key)));
  // code(物理キー)が一致するか、key(文字)が一致すれば採用。iOS/HID で code が空でも動くように両方見る
  const matchKey=(e,b)=>!!b&&((b.code&&e.code&&e.code===b.code)||(e.key&&e.key.toLowerCase()===b.key));
  function runAction(id){
    if(id==='steer'){footFlash();tap();}
    else if(id==='toggle'){footFlash();toggle();toggleHoldStart();}   // keyup 側で toggleHoldEnd()
    else if(id==='reset'){footFlash();resetHome();}
    else if(id==='next'){footFlash();nextSection();}
    else if(id==='prev'){footFlash();prevSection();}
    else if(id==='home'){homePressStart();}              // 解放時に短押し(トグル)/長押し(即復帰)を判定。keyup 側で homePressEnd()
    else if(id==='jump'){footFlash();jumpHome();}
    else if(id==='auto'){footFlash();toggleAutoReturn();}
    else if(id==='stage'){toggleStage();}
  }
  function renderKeymap(){
    const w=$('#keymapList'); if(!w)return; w.innerHTML='';
    ACTIONS.forEach(a=>{
      const row=document.createElement('div'); row.className='keyrow';
      row.innerHTML='<span class="nm">'+a.l+'</span><kbd>'+escapeHtml(keyLabel(keymap[a.id]))+'</kbd>'
        +'<button class="iconbtn'+(keyLearn===a.id?' pri':'')+'" data-learn="'+a.id+'">'+(keyLearn===a.id?'キーを押して…':'変更')+'</button>';
      row.querySelector('[data-learn]').onclick=()=>{ keyLearn=(keyLearn===a.id?null:a.id); renderKeymap(); };
      w.appendChild(row);
    });
    const h=$('#helpKeys'); if(h) h.innerHTML=ACTIONS.map(a=>'<kbd>'+escapeHtml(keyLabel(keymap[a.id]))+'</kbd> '+a.l.replace(/（.*）/,'')).join(' ・ ');
  }
  function noteKeyEvent(e){ const d=$('#keyDiag'); if(d) d.textContent='最後に受け取ったキー: '+e.type+'  key="'+e.key+'"  code="'+(e.code||'')+'"  keyCode='+e.keyCode+(e.repeat?'  (repeat)':''); }

  // ---- setlist / sections ----
  // song = {name, sections:[{name,targetBPM,beatsPerBar,noteValue,subdivision,accents,bars}], soundType, recPct}
  let songs=[];
  let curSong=-1, curSec=-1;
  let secAuto=false, barsElapsed=0;
  const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const sigLabelOf=(b,n)=>SIGS.find(s=>s.b===b&&s.n===n)?.l || (b+'/'+n);

  function snapshotSection(name,bars){
    return {name:name||'', targetBPM, beatsPerBar, noteValue, subdivision, accents:accents.slice(), bars:(bars|0)||0};
  }
  function snapshotSong(name){
    return {name:name||'', soundType, recPct, sections:[snapshotSection('',0)]};
  }
  // 旧形式(単一設定の曲)を読み込んだ時に sections へ移行
  function migrateSong(s){
    if(s && Array.isArray(s.sections)) return s;
    return {name:s.name||'', soundType:s.soundType||'beep', recPct:(s.recPct!=null?s.recPct:0.10),
      sections:[{name:'', targetBPM:s.targetBPM||120, beatsPerBar:s.beatsPerBar||4, noteValue:s.noteValue||4,
                 subdivision:s.subdivision||1, accents:Array.isArray(s.accents)?s.accents.slice():[2,1,1,1], bars:0}]};
  }
  function applySection(sec){
    if(!sec)return;
    targetBPM=clamp(sec.targetBPM,BPM_MIN,BPM_MAX);
    beatsPerBar=sec.beatsPerBar; noteValue=sec.noteValue; subdivision=sec.subdivision;
    accents=(Array.isArray(sec.accents)&&sec.accents.length===sec.beatsPerBar)?sec.accents.slice():defaultAccents(sec.beatsPerBar);
    if(!isPlaying) currentBPM=targetBPM;     // 再生中はステア/復帰に任せて滑らかに移行
    barsElapsed=0;
    refreshAll(); renderRing(); renderSections();
  }
  function applySong(s){
    s=migrateSong(s);
    soundType=s.soundType||'beep'; recPct=(s.recPct!=null?s.recPct:0.10);
    $('#recSlider').value=Math.round(recPct*100);
    curSec=0; applySection(s.sections[0]);
  }
  function curSongObj(){ return (curSong>=0&&curSong<songs.length)?songs[curSong]:null; }
  function curSections(){ const s=curSongObj(); return s?s.sections:[]; }

  let projName='';
  function persistSongs(){ Store.set(SL_KEY,{v:2,name:projName,songs,cur:curSong,secAuto}); }
  function loadSongs(){
    const d=Store.get(SL_KEY,null);
    if(d&&Array.isArray(d.songs)){ songs=d.songs.map(migrateSong); curSong=(d.cur!=null?d.cur:-1); secAuto=!!d.secAuto; projName=d.name||''; }
  }
  function projectJSON(){ return JSON.stringify({app:'metronos',v:2,name:projName,songs,secAuto},null,2); }
  function setNote(t){ $('#slPersistNote').textContent=t; }
  // 書き出し/ファイル 共通の取り込み。旧形式（配列だけ）も受ける
  function importProject(text){
    try{
      const d=JSON.parse(text);
      const arr=Array.isArray(d)?d:(d&&Array.isArray(d.songs)?d.songs:null);
      if(!arr){ setNote('プロジェクトJSONではありません'); return false; }
      songs=arr.map(migrateSong); curSong=-1; curSec=-1;
      if(d&&d.secAuto!=null){ secAuto=!!d.secAuto; $('#secAutoToggle').classList.toggle('on',secAuto); }
      if(d&&typeof d.name==='string'){ projName=d.name; $('#projName').value=projName; }
      persistSongs(); renderSetlist(); renderSections();
      setNote('読み込みました（'+songs.length+'曲）');
      return true;
    }catch(e){ setNote('JSONを解析できませんでした'); return false; }
  }
  function saveProjectFile(){
    projName=$('#projName').value.trim(); persistSongs();
    const blob=new Blob([projectJSON()],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=(projName||'metronos')+'.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNote('保存しました: '+a.download);
  }

  function addSong(){ const nm=$('#songName').value.trim()||('曲 '+(songs.length+1)); songs.push(snapshotSong(nm)); curSong=songs.length-1; curSec=0; $('#songName').value=''; editing=null; persistSongs(); renderSetlist(); }
  function deleteSong(i){ songs.splice(i,1); if(curSong>=songs.length)curSong=songs.length-1; else if(i<curSong)curSong--; curSec=curSong>=0?0:-1; editing=null; persistSongs(); renderSetlist(); }
  // 並べ替え（ドラッグ）。選択中のインデックスも追従させる
  function moveIndex(cur,from,to){ if(cur===from)return to; if(from<cur&&to>=cur)return cur-1; if(from>cur&&to<=cur)return cur+1; return cur; }
  function reorderSongs(from,to){ if(from===to)return; const [s]=songs.splice(from,1); songs.splice(to,0,s); curSong=moveIndex(curSong,from,to); editing=null; persistSongs(); renderSetlist(); }
  function reorderSections(from,to){ const s=curSongObj(); if(!s||from===to)return; const [x]=s.sections.splice(from,1); s.sections.splice(to,0,x); curSec=moveIndex(curSec,from,to); editing=null; persistSongs(); renderSetlist(); }

  // ---- drag to reorder（Pointer Events。iPad/タッチでも動く）----
  // container 直下の itemSel 要素を、.grip を掴んで上下に並べ替える。離した時に onDrop(from,to)
  const GRIP='<span class="grip" title="ドラッグで並べ替え"><svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="2.5" r="1.6"/><circle cx="7.5" cy="2.5" r="1.6"/><circle cx="2.5" cy="8" r="1.6"/><circle cx="7.5" cy="8" r="1.6"/><circle cx="2.5" cy="13.5" r="1.6"/><circle cx="7.5" cy="13.5" r="1.6"/></svg></span>';
  function makeSortable(container,itemSel,onDrop){
    const items=()=>[...container.querySelectorAll(':scope > '+itemSel)];
    container.querySelectorAll(':scope > '+itemSel+' .grip').forEach(grip=>{
      const src=grip.closest('.sec, .songBlk');
      if(!src.matches(itemSel)||src.parentElement!==container) return;   // 入れ子の grip は自分のコンテナだけ
      grip.addEventListener('pointerdown',e=>{
        if(e.pointerType==='mouse'&&e.button!==0)return;
        e.preventDefault(); e.stopPropagation();
        const from=items().indexOf(src);
        const face=src.querySelector(':scope > .song')||src;   // 曲は見出し行だけをゴーストに
        const r=face.getBoundingClientRect(); const offY=e.clientY-r.top;
        container.querySelectorAll('.edit').forEach(x=>x.remove()); editing=null;   // 開いてるフォームは閉じる
        const ghost=face.cloneNode(true); ghost.className=face.className+' dragGhost';
        ghost.style.width=r.width+'px'; ghost.style.left=r.left+'px'; ghost.style.top=r.top+'px';
        document.body.appendChild(ghost); src.classList.add('dragSrc'); document.body.classList.add('dragging');
        try{ grip.setPointerCapture(e.pointerId); }catch(x){}
        const move=ev=>{
          ev.preventDefault();
          ghost.style.top=(ev.clientY-offY)+'px';
          const others=items().filter(x=>x!==src);
          const next=others.find(x=>{const b=x.getBoundingClientRect(); return ev.clientY < b.top+b.height/2;});
          if(next) container.insertBefore(src,next);
          else if(others.length) container.insertBefore(src,others[others.length-1].nextSibling);
        };
        const up=()=>{
          window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); window.removeEventListener('pointercancel',up);
          ghost.remove(); src.classList.remove('dragSrc'); document.body.classList.remove('dragging');
          const to=items().indexOf(src);
          if(to!==from) onDrop(from,to); else renderSetlist();
        };
        window.addEventListener('pointermove',move,{passive:false}); window.addEventListener('pointerup',up); window.addEventListener('pointercancel',up);
      });
    });
  }
  function loadSong(i){ if(i<0||i>=songs.length)return; curSong=i; editing=null; applySong(songs[i]); persistSongs(); renderSetlist(); }
  function prevSong(){ if(!songs.length)return; loadSong(curSong<=0?songs.length-1:curSong-1); }
  function nextSong(){ if(!songs.length)return; loadSong(curSong>=songs.length-1?0:curSong+1); }

  // ---- inline editor（曲名 / セクション）----
  // editing = null | {kind:'song', song:i} | {kind:'sec', song:i, sec:j}  (sec=-1 は新規追加)
  let editing=null;
  const optionsHtml=(list,val)=>list.map(o=>'<option value="'+o.v+'"'+(String(o.v)===String(val)?' selected':'')+'>'+o.l+'</option>').join('');
  function secEditorHtml(sec,isNew){
    const sigv=sec.beatsPerBar+'/'+sec.noteValue;
    const sigs=SIGS.map(s=>({v:s.b+'/'+s.n,l:s.l}));
    if(!sigs.some(o=>o.v===sigv)) sigs.push({v:sigv,l:sigv});          // ±で作った変拍子
    return '<div class="edit">'
      +'<div class="row" style="gap:8px;flex-wrap:wrap">'
      +  '<label class="fld grow">セクション名<input type="text" id="edName" value="'+escapeHtml(sec.name||'')+'" placeholder="Aメロ / サビ など"></label>'
      +  '<label class="fld">小節数<input type="number" id="edBars" value="'+(sec.bars|0)+'" min="0" max="999" inputmode="numeric"></label>'
      +'</div>'
      +'<div class="row" style="gap:8px;flex-wrap:wrap">'
      +  '<label class="fld">BPM<input type="number" id="edBpm" value="'+sec.targetBPM+'" min="20" max="300" inputmode="numeric"></label>'
      +  '<label class="fld">拍子<select id="edSig">'+optionsHtml(sigs,sigv)+'</select></label>'
      +  '<label class="fld">リズム<select id="edSub">'+optionsHtml(SUBS.map(s=>({v:s.v,l:s.l})),sec.subdivision)+'</select></label>'
      +'</div>'
      +'<div class="row" style="gap:8px;flex-wrap:wrap">'
      +  '<button class="iconbtn pri" id="edSave">'+(isNew?'追加':'保存')+'</button>'
      +  '<button class="iconbtn" id="edCancel">キャンセル</button>'
      +  '<button class="iconbtn" id="edPull" title="メイン画面で設定中のBPM・拍子・リズムをこのフォームに入れる">画面の値を入れる</button>'
      +  (isNew?'':'<button class="iconbtn" id="edDel" style="margin-left:auto;color:var(--bad)">削除</button>')
      +'</div>'
      +'<div class="hint" style="margin-top:0">小節数0＝手動送りのみ。アクセントは選択中のセクションの拍ドットで編集し、保存時に一緒に記録されます。</div>'
      +'</div>';
  }
  function songEditorHtml(s){
    return '<div class="edit">'
      +'<div class="row" style="gap:8px"><label class="fld grow">曲名<input type="text" id="edName" value="'+escapeHtml(s.name||'')+'"></label></div>'
      +'<div class="row" style="gap:8px;flex-wrap:wrap"><button class="iconbtn pri" id="edSave">保存</button><button class="iconbtn" id="edCancel">キャンセル</button>'
      +'<span class="hint" style="margin:0 0 0 auto">音色・復帰速度は今の設定で保存されます</span></div>'
      +'</div>';
  }
  function readSecEditor(){
    const [b,n]=$('#edSig').value.split('/').map(x=>parseInt(x,10));
    return {
      name:$('#edName').value.trim(), bars:parseInt($('#edBars').value||'0',10)||0,
      targetBPM:clamp(parseInt($('#edBpm').value||'120',10)||120,BPM_MIN,BPM_MAX),
      beatsPerBar:clamp(b||4,1,12), noteValue:n||4, subdivision:parseInt($('#edSub').value,10)||1
    };
  }
  function wireEditor(el){
    $('#edCancel').onclick=()=>{ editing=null; renderSetlist(); };
    if(editing.kind==='song'){
      $('#edSave').onclick=()=>{
        const s=songs[editing.song]; s.name=$('#edName').value.trim()||s.name; s.soundType=soundType; s.recPct=recPct;
        editing=null; persistSongs(); renderSetlist();
      };
      return;
    }
    $('#edPull').onclick=()=>{
      $('#edBpm').value=targetBPM; $('#edSub').value=subdivision;
      const sel=$('#edSig'), v=beatsPerBar+'/'+noteValue;
      if(![...sel.options].some(o=>o.value===v)){ const o=document.createElement('option');o.value=v;o.textContent=v;sel.appendChild(o); }
      sel.value=v;
    };
    $('#edSave').onclick=()=>{
      const s=songs[editing.song]; const e=readSecEditor(); const j=editing.sec;
      const isCur=(editing.song===curSong && j===curSec);
      const old=j>=0?s.sections[j]:null;
      // アクセント：選択中の区間なら拍ドット(live)の値、そうでなければ元の値。拍数が変わったら初期化
      let acc=defaultAccents(e.beatsPerBar);
      if(isCur && beatsPerBar===e.beatsPerBar) acc=accents.slice();
      else if(old && old.beatsPerBar===e.beatsPerBar) acc=old.accents.slice();
      const sec=Object.assign(e,{accents:acc});
      editing=null;
      if(j<0){ s.sections.push(sec); persistSongs(); if(s===curSongObj()) gotoSection(s.sections.length-1); else renderSetlist(); }
      else { s.sections[j]=sec; persistSongs(); if(isCur) applySection(sec); else renderSetlist(); }
    };
    const del=$('#edDel');
    if(del) del.onclick=()=>{
      const s=songs[editing.song]; if(s.sections.length<=1)return;
      const j=editing.sec; s.sections.splice(j,1);
      if(editing.song===curSong){ if(curSec>=s.sections.length)curSec=s.sections.length-1; else if(j<curSec)curSec--; }
      editing=null; persistSongs();
      if(s===curSongObj()) applySection(s.sections[curSec]); else renderSetlist();
    };
  }

  function gotoSection(i){
    const s=curSongObj(); if(!s)return;
    if(i<0||i>=s.sections.length)return;
    curSec=i; applySection(s.sections[i]); persistSongs();
  }
  function nextSection(){
    const s=curSongObj(); if(!s)return;
    if(curSec>=s.sections.length-1){ nextSong(); return; }   // 曲末なら次の曲へ
    gotoSection(curSec+1);
  }
  function prevSection(){
    const s=curSongObj(); if(!s)return;
    if(curSec<=0){ prevSong(); return; }
    gotoSection(curSec-1);
  }
  function renderSections(){ renderSetlist(); }   // 旧API互換（セクションはセットリスト内に入れ子表示）

  function renderSecNow(){
    const s=curSongObj();
    const txt = s && curSec>=0
      ? (escapeHtml(s.name||'曲')+' — <b>'+escapeHtml(s.sections[curSec].name||('セクション '+(curSec+1)))+'</b> ('+(curSec+1)+'/'+s.sections.length+')')
      : '';
    const b=$('#secNowTop'); if(b) b.innerHTML=txt;
  }

  // セットリスト：曲 → その下にセクションを入れ子表示（展開は選択中の曲のみ）。✎ で行の直下にフォームが開く
  function renderSetlist(){
    const wrap=$('#setlist'); wrap.innerHTML='';
    if(!songs.length){ wrap.innerHTML='<div class="emptyNote">まだ曲がありません。下の「＋曲を追加」で今の設定を1曲目として登録。</div>'; }
    songs.forEach((s,i)=>{
      const nsec=s.sections.length, isCur=(i===curSong);
      const blk=document.createElement('div'); blk.className='songBlk'+(isCur?' cur':'');
      const head=document.createElement('div'); head.className='song'+(isCur?' cur':'');
      head.innerHTML=GRIP
        +'<span class="nm">'+escapeHtml(s.name||('曲 '+(i+1)))+'</span>'
        +'<span class="meta">'+(isCur?(nsec+'セクション'):(s.sections[0].targetBPM+'・'+sigLabelOf(s.sections[0].beatsPerBar,s.sections[0].noteValue)+(nsec>1?('・'+nsec+'区間'):'')))+'</span>'
        +'<button class="mv" data-mv="edit" title="曲名を編集">✎</button>'
        +'<button class="mv del" data-mv="del" title="削除">✕</button>';
      head.querySelector('.nm').onclick=()=>loadSong(i);
      head.querySelector('[data-mv="edit"]').onclick=(e)=>{e.stopPropagation();editing={kind:'song',song:i};renderSetlist();};
      head.querySelector('[data-mv="del"]').onclick=(e)=>{e.stopPropagation();deleteSong(i);};
      blk.appendChild(head);
      if(editing&&editing.kind==='song'&&editing.song===i){ const ed=document.createElement('div'); ed.innerHTML=songEditorHtml(s); blk.appendChild(ed.firstChild); }
      if(isCur){
        const secs=document.createElement('div'); secs.className='secs';
        s.sections.forEach((sec,j)=>{
          const el=document.createElement('div'); el.className='sec'+(j===curSec?' cur':'');
          el.innerHTML=GRIP+'<span class="nm">'+escapeHtml(sec.name||('セクション '+(j+1)))+'</span>'
            +'<span class="meta">'+sec.targetBPM+'・'+sigLabelOf(sec.beatsPerBar,sec.noteValue)+'・'+SUBS.find(x=>x.v===sec.subdivision)?.l+(sec.bars?('・'+sec.bars+'小節'):'')+'</span>'
            +'<button class="mv" data-mv="edit" title="編集">✎</button>';
          el.querySelector('.nm').onclick=()=>gotoSection(j);
          el.querySelector('[data-mv="edit"]').onclick=(e)=>{e.stopPropagation();editing={kind:'sec',song:i,sec:j};renderSetlist();};
          secs.appendChild(el);
          if(editing&&editing.kind==='sec'&&editing.song===i&&editing.sec===j){ const ed=document.createElement('div'); ed.innerHTML=secEditorHtml(sec,false); secs.appendChild(ed.firstChild); }
        });
        const add=document.createElement('button'); add.className='iconbtn secAddBtn'; add.textContent='＋ セクションを追加';
        add.onclick=()=>{ editing={kind:'sec',song:i,sec:-1}; renderSetlist(); };
        secs.appendChild(add);
        if(editing&&editing.kind==='sec'&&editing.song===i&&editing.sec===-1){
          const ed=document.createElement('div'); ed.innerHTML=secEditorHtml({name:'',bars:0,targetBPM,beatsPerBar,noteValue,subdivision},true); secs.appendChild(ed.firstChild);
        }
        blk.appendChild(secs);
        makeSortable(secs,'.sec',reorderSections);
      }
      wrap.appendChild(blk);
    });
    makeSortable(wrap,'.songBlk',reorderSongs);
    if(editing){ wireEditor(); const f=$('#edName'); if(f&&editing.sec===-1) f.focus(); }
    $('#slCount').textContent=songs.length+'曲';
    $('#songPos').textContent= songs.length? ('曲 '+(curSong>=0?curSong+1:'-')+'/'+songs.length) : '—';
    setNote(Store.ok ? 'この端末（ブラウザ）に自動保存されます。ファイル保存でバックアップ・端末間移行ができます。' : '※ この環境では自動保存されません。ファイルに保存してください。');
    renderSecNow();
  }

  // ---- MIDI ----
  let midiAccess=null, midiLearnMode=false, midiNote=null; // midiNote=null:全ノートで反応
  const midiSupported=()=>!!navigator.requestMIDIAccess;
  function setMidiStatus(state,text){ const el=$('#midiStatus'); el.classList.remove('on','err'); if(state==='on')el.classList.add('on'); if(state==='err')el.classList.add('err'); $('#midiStatusText').textContent=text; }
  function enableMIDI(){
    if(!midiSupported()){
      setMidiStatus('err','Web MIDI非対応');
      $('#midiHint').innerHTML='このブラウザ/端末はWeb MIDI非対応です（iPhone/iPadのSafariは全て非対応）。Android Chromeや、PCのChrome系でお試しください。iOSはアプリ化でネイティブMIDI対応にできます。';
      return;
    }
    navigator.requestMIDIAccess({sysex:false}).then(acc=>{ midiAccess=acc; acc.onstatechange=attachMidi; attachMidi(); })
      .catch(()=>setMidiStatus('err','許可されませんでした'));
  }
  function attachMidi(){
    if(!midiAccess)return; const names=[];
    midiAccess.inputs.forEach(inp=>{ inp.onmidimessage=onMidi; names.push(inp.name||'MIDI'); });
    $('#midiDevices').textContent = names.length? ('入力: '+names.join(' / ')) : '入力デバイスが見つかりません';
    setMidiStatus(names.length?'on':'err', names.length?'接続済み':'デバイスなし');
  }
  function onMidi(ev){
    const st=ev.data[0], d1=ev.data[1], d2=ev.data[2];
    const noteOn=((st&0xf0)===0x90)&&d2>0;
    if(!noteOn)return;
    if(midiLearnMode){ midiNote=d1; midiLearnMode=false; updateMidiButtons(); $('#midiHint').textContent='ノート '+d1+' を学習しました。このパッドだけで叩けます。'; return; }
    if(midiNote!=null && d1!==midiNote) return;
    tap();
  }
  function updateMidiButtons(){
    $('#midiLearn').classList.toggle('pri',midiLearnMode);
    $('#midiLearn').textContent = midiLearnMode? '次に叩いたノートを学習…' : (midiNote!=null? ('指定: ノート'+midiNote) : 'ノート指定（学習）');
    $('#midiAny').classList.toggle('pri',midiNote==null);
  }

  function renderRing(){
    const r=$('#ring');r.innerHTML='';
    for(let i=0;i<beatsPerBar;i++){
      const lv=accents[i]==null?1:accents[i];
      const d=document.createElement('div');d.className='dot lv'+lv;d.dataset.i=i;d.title='タップでアクセント切替';
      d.onclick=()=>{ accents[i]=((accents[i]==null?1:accents[i])+1)%4; renderRing(); };
      r.appendChild(d);
    }
  }
  function clearRing(){ renderRing(); }

  // refresh display bits
  function setTarget(v){ targetBPM=clamp(Math.round(v),BPM_MIN,BPM_MAX); currentBPM=targetBPM; clearMeasure(); refreshTempo(); }
  function refreshTempo(){
    $('#bpmInput').value=targetBPM; $('#bpmSlider').value=targetBPM;
    $('#tVal').textContent=targetBPM+' BPM';
    $('#tempoName').textContent=tempoMarking(targetBPM);
  }
  function refreshSig(){
    const lab=SIGS.find(s=>s.b===beatsPerBar&&s.n===noteValue)?.l || (beatsPerBar+'/'+noteValue);
    $('#sigVal').textContent=lab;$('#sigLabel').textContent=beatsPerBar+' / '+noteValue;$('#beatsView').textContent=beatsPerBar;
    document.querySelectorAll('#sigChips .chip').forEach(c=>c.classList.toggle('on',c.textContent===lab));
  }
  function refreshSub(){$('#subVal').textContent=SUBS.find(s=>s.v===subdivision).l;
    document.querySelectorAll('#subChips .chip').forEach(c=>c.classList.toggle('on',+c.dataset.v===subdivision));}
  function refreshSound(){document.querySelectorAll('#soundChips .chip').forEach(c=>c.classList.toggle('on',c.dataset.v===soundType));}
  function refreshRec(){recPct=(+$('#recSlider').value)/100;$('#recVal').textContent='1拍あたり '+$('#recSlider').value+'%';}
  function refreshVol(){$('#volVal').textContent=Math.round(volume*100);$('#volSlider').value=Math.round(volume*100);}
  function refreshAccent(){renderRing();}
  function refreshAll(){refreshTempo();refreshSig();refreshSub();refreshSound();refreshRec();refreshVol();refreshAccent();}

  function paintTransport(){
    const playing=isPlaying;
    $('#startBtn').classList.toggle('playing',playing);
    $('#startTxt').textContent=playing?'ストップ':(isPaused()?'再開':'スタート');
    $('#startIc').innerHTML=playing
      ? '<svg viewBox="0 0 14 14" width="14" height="14"><rect x="2" y="2" width="3.5" height="10" fill="currentColor"/><rect x="8.5" y="2" width="3.5" height="10" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M3 2 L12 7 L3 12 Z" fill="currentColor"/></svg>';
    $('#statusMark').textContent=playing?'再生中':'停止中';
    $('#statusMark').classList.toggle('on',playing);
    $('#steerLbl').textContent='タップテンポ';
    $('#steerSub').textContent=playing
      ? (autoReturn ? '叩いた間隔でテンポを握り、放すと目標へ戻ります' : '叩いた間隔でテンポを握ったまま保持。「ホームへ戻る」で復帰')
      : (autoReturn ? '叩いた間隔の平均でテンポを測定 → スタートでそのテンポから再生、やめると目標へ自然復帰' : '叩いた間隔の平均でテンポを測定 → スタートでそのテンポから再生、「ホームへ戻る」で復帰');
    if(!playing && measuredBPM==null){$('#tapBpm').innerHTML='&nbsp;';}
    $('#tapSoundToggle').classList.toggle('on',tapSound);
    // 戻るボタンの文言は復帰の進み具合で変わるので frame() 側で毎フレーム更新する
    $('#returnBtn').disabled=!playing;
    paintReturnBtn();
    $('#autoReturnToggle').classList.toggle('on',autoReturn);
  }

  // 戻るボタン：保持中は「復帰開始」として脈打たせ、復帰中は「復帰一時停止」、ホームにいれば「ホームへ戻る」
  function paintReturnBtn(){
    const away=isPlaying && Math.abs(currentBPM-targetBPM)>=0.05;
    $('#returnBtn').classList.toggle('armed',isPlaying&&holding);
    $('#returnTxt').textContent = (isPlaying&&holding) ? '復帰開始' : away ? '復帰一時停止' : 'ホームへ戻る';
  }

  // ---- visual loop (beat lights + meter + number color) ----
  function frame(){
    if(ctx && isPlaying){
      const now=ctx.currentTime;
      while(visualQueue.length && visualQueue[0].t<=now){
        const v=visualQueue.shift();
        lastBeatT=v.t; lastBeatIdx=v.beat;
        lightBeat(v.beat);
      }
      // big number + color
      const shown=Math.round(currentBPM);
      $('#bpmNow').innerHTML=shown+'<small> BPM</small>';
      const off=clamp(Math.abs(currentBPM-targetBPM)/18,0,1);
      const col=mix(HOME,LIVE,off);
      $('#bpmNow').style.color=col;
      $('#tempoName').style.color=mix(HOME,LIVE,off);
      // 小節カウンタ
      const s=curSongObj(); const sec=(s&&curSec>=0)?s.sections[curSec]:null;
      $('#barCount').textContent = sec&&sec.bars ? (barsElapsed+1)+'/'+sec.bars+'小節' : (isPlaying?(barsElapsed+1)+'小節':'');
      const tl=$('#targetLine');
      tl.classList.toggle('hold',holding);
      if(holding){
        tl.innerHTML='保持中 — ホーム <b>'+targetBPM+'</b>（ボタンで復帰開始）';
      }else if(Math.abs(currentBPM-targetBPM)>=1){
        tl.innerHTML='ホーム <b>'+targetBPM+'</b> へ復帰中…（ボタンで一時停止）';
      }else tl.innerHTML='&nbsp;';
      paintReturnBtn();
      // meter marker: target at center, ±24 window
      const win=24;
      let pos=0.5+clamp((currentBPM-targetBPM)/win,-1,1)*0.5;
      const lm=$('#liveMark');
      lm.style.left=(pos*100)+'%'; lm.style.opacity='1'; lm.style.background=col;
    }else if(measuredBPM!=null){
      // 停止中の測定：大きな表示を測定値に切り替える（ホームとの差で色づけ）
      const off=clamp(Math.abs(measuredBPM-targetBPM)/18,0,1);
      $('#bpmNow').innerHTML=Math.round(measuredBPM)+'<small> BPM</small>';
      $('#bpmNow').style.color=mix(HOME,LIVE,off);
      $('#targetLine').innerHTML='ホーム <b>'+targetBPM+'</b> — スタートでこのテンポから開始';
      $('#targetLine').classList.remove('hold');
      $('#barCount').textContent='';
      $('#liveMark').style.opacity='0';
    }else if(isPaused()){
      // 一時停止：止めたときのテンポを出したまま（スタートで再開）
      const off=clamp(Math.abs(currentBPM-targetBPM)/18,0,1);
      $('#bpmNow').innerHTML=Math.round(currentBPM)+'<small> BPM</small>';
      $('#bpmNow').style.color=mix(HOME,LIVE,off);
      $('#targetLine').innerHTML='一時停止中 — ホーム <b>'+targetBPM+'</b>（再開でこのテンポから）';
      $('#targetLine').classList.toggle('hold',holding);
      $('#startTxt').textContent='再開';
      $('#barCount').textContent='';
      $('#liveMark').style.opacity='0';
    }else{
      $('#bpmNow').innerHTML=targetBPM+'<small> BPM</small>';
      $('#bpmNow').style.color='var(--ink)';
      $('#targetLine').innerHTML='&nbsp;';
      $('#targetLine').classList.remove('hold');
      $('#startTxt').textContent='スタート';
      $('#barCount').textContent='';
      $('#liveMark').style.opacity='0';
    }
    requestAnimationFrame(frame);
  }
  function lightBeat(i){
    const dots=document.querySelectorAll('.dot');
    dots.forEach(d=>{d.classList.remove('on');d.style.background='';d.style.boxShadow='';});
    const d=dots[i]; if(!d)return;
    const off=clamp(Math.abs(currentBPM-targetBPM)/18,0,1);
    const col=mix(HOME,LIVE,off);
    d.classList.add('on'); d.style.background=col; d.style.boxShadow='0 0 14px '+col;
  }

  function flashPad(steer){
    const p=$('#steerPad'); p.classList.add('hit');
    setTimeout(()=>p.classList.remove('hit'),110);
  }

  // ---- events ----
  // スタートボタン：click でトグル（iOS のオーディオ解錠は touchend/click 側で済ませる）、長押しでホームに戻して停止
  {
    const sb=$('#startBtn'); let longFired=false, t=null;
    sb.addEventListener('pointerdown',e=>{ if(e.button!==0&&e.pointerType==='mouse')return; longFired=false; t=setTimeout(()=>{ t=null; longFired=true; footFlash(); resetHome(); },HOLD_MS); });
    ['pointerup','pointercancel','pointerleave'].forEach(ev=>sb.addEventListener(ev,()=>{ if(t!=null){clearTimeout(t);t=null;} }));
    sb.addEventListener('click',()=>{ if(longFired){ longFired=false; return; } toggle(); });   // 長押し後の click は食う
    sb.addEventListener('contextmenu',e=>e.preventDefault());
  }
  // 画面ボタンも押下→解放で判定（長押し＝即ホーム）。click は使わない
  {
    const rb=$('#returnBtn');
    rb.addEventListener('pointerdown',e=>{ if(e.button!==0&&e.pointerType==='mouse')return; if(rb.disabled)return; homePressStart(); });
    ['pointerup','pointercancel','pointerleave'].forEach(t=>rb.addEventListener(t,homePressEnd));
    rb.addEventListener('contextmenu',e=>e.preventDefault());   // タッチ長押しのメニュー抑止
  }
  function toggleAutoReturn(){ autoReturn=!autoReturn; if(autoReturn) holding=false; persistPrefs(); paintTransport(); }
  $('#autoReturnToggle').onclick=toggleAutoReturn;
  $('#tapSoundToggle').onclick=()=>{ tapSound=!tapSound; persistPrefs(); paintTransport(); };
  const padDown=(e)=>{ if(e.type==='pointerdown'&&e.button!==0&&e.pointerType==='mouse')return; tap(); };
  $('#steerPad').addEventListener('pointerdown',padDown);

  $('#bpmInput').addEventListener('input',e=>{let v=parseInt(e.target.value||'0',10);if(!isNaN(v)){targetBPM=clamp(v,BPM_MIN,BPM_MAX);currentBPM=targetBPM;clearMeasure();$('#bpmSlider').value=targetBPM;$('#tVal').textContent=targetBPM+' BPM';$('#tempoName').textContent=tempoMarking(targetBPM);}});
  $('#bpmInput').addEventListener('blur',refreshTempo);
  $('#bpmSlider').addEventListener('input',e=>{setTarget(+e.target.value);});
  $('#bpmUp').onclick=()=>setTarget(targetBPM+1);
  $('#bpmDown').onclick=()=>setTarget(targetBPM-1);
  document.querySelectorAll('[data-bpm]').forEach(b=>b.onclick=()=>setTarget(targetBPM+ +b.dataset.bpm));

  $('#beatsUp').onclick=()=>{beatsPerBar=clamp(beatsPerBar+1,1,12);resizeAccents(beatsPerBar);refreshSig();renderRing();};
  $('#beatsDown').onclick=()=>{beatsPerBar=clamp(beatsPerBar-1,1,12);resizeAccents(beatsPerBar);refreshSig();renderRing();};
  $('#accentReset').onclick=()=>{accents=defaultAccents(beatsPerBar);renderRing();};
  $('#recSlider').addEventListener('input',refreshRec);
  $('#volSlider').addEventListener('input',e=>{volume=(+e.target.value)/100;refreshVol();});

  // setlist
  $('#songAdd').onclick=addSong;
  // sections (nav; editing is inline in the setlist)
  $('#secPrev').onclick=prevSection;
  $('#secNext').onclick=nextSection;
  $('#secAutoToggle').onclick=()=>{ secAuto=!secAuto; $('#secAutoToggle').classList.toggle('on',secAuto); persistSongs(); };
  // project file / text
  $('#projName').addEventListener('change',()=>{ projName=$('#projName').value.trim(); persistSongs(); });
  $('#projSave').onclick=saveProjectFile;
  $('#projLoad').onclick=()=>$('#projFile').click();
  $('#projFile').addEventListener('change',e=>{
    const f=e.target.files&&e.target.files[0]; if(!f)return;
    f.text().then(importProject); e.target.value='';
  });
  $('#ioToggle').onclick=()=>{ const b=$('#ioBox'),r=$('#ioBtns'); const show=b.style.display!=='block'; b.style.display=show?'block':'none'; r.style.display=show?'flex':'none'; };
  $('#ioExport').onclick=()=>{ $('#ioBox').value=projectJSON(); $('#ioBox').select(); };
  $('#ioImport').onclick=()=>importProject($('#ioBox').value);

  // midi
  $('#midiEnable').onclick=enableMIDI;
  $('#midiLearn').onclick=()=>{ midiLearnMode=!midiLearnMode; if(midiLearnMode)midiNote=null; updateMidiButtons(); };
  $('#midiAny').onclick=()=>{ midiNote=null; midiLearnMode=false; updateMidiButtons(); $('#midiHint').textContent='全ノートで反応します。'; };

  window.addEventListener('keydown',e=>{
    noteKeyEvent(e);
    if(keyLearn){                             // 学習モード：次に押されたキーを割り当て
      e.preventDefault();
      if(e.key==='Shift'||e.key==='Control'||e.key==='Alt'||e.key==='Meta')return;
      keymap[keyLearn]={key:e.key.toLowerCase(),code:e.code||''}; keyLearn=null; persistPrefs(); renderKeymap(); return;
    }
    if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
    if(e.repeat)return;                       // キーリピート無視（踏みっぱなし誤爆防止）
    const act=ACTIONS.find(a=>matchKey(e,keymap[a.id]));
    if(!act)return;
    e.preventDefault(); runAction(act.id);
  },{capture:true});
  // Space等でフォーカス中のボタンが再発火しないように。「ホームへ戻る」は解放時に短押し/長押しを確定する
  window.addEventListener('keyup',e=>{
    noteKeyEvent(e);
    if(matchKey(e,keymap.home)) homePressEnd();
    if(matchKey(e,keymap.toggle)) toggleHoldEnd();
    if(ACTIONS.some(a=>matchKey(e,keymap[a.id]))) e.preventDefault();
  },{capture:true});
  $('#keymapReset').onclick=()=>{ ACTIONS.forEach(a=>keymap[a.id]={...a.def}); keyLearn=null; persistPrefs(); renderKeymap(); };

  function footFlash(){ const b=$('#footBadge'); b.classList.add('hit'); setTimeout(()=>b.classList.remove('hit'),120); }

  // ---- stage mode ----
  let stageOn=false;
  function toggleStage(){ stageOn=!stageOn; document.body.classList.toggle('stage',stageOn); $('#stageBtn').classList.toggle('pri',stageOn); }
  $('#stageBtn').onclick=toggleStage;
  $('#stageExit').onclick=toggleStage;

  // ---- wake lock（ステージで画面を消さない）----
  let wakeLock=null;
  async function requestWake(){
    try{ if('wakeLock' in navigator){ wakeLock=await navigator.wakeLock.request('screen'); } }catch(e){}
  }
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&isPlaying) requestWake(); });

  // ---- init ----
  buildChips();
  loadPrefs();
  loadSongs();
  $('#projName').value=projName;
  if(curSongObj()) applySong(curSongObj());   // 前回の曲を復元（起動直後から曲/セクションが選択された状態にする）
  renderRing();
  refreshAll();
  renderSetlist();
  renderSections();
  $('#secAutoToggle').classList.toggle('on',secAuto);
  updateMidiButtons();
  renderKeymap();
  setMidiStatus('', midiSupported()?'未接続（タップで有効化）':'Web MIDI非対応');
  paintTransport();
  requestAnimationFrame(frame);

  // ---- PWA: Service Worker 登録（manifest は index.html でリンク）----
  if('serviceWorker' in navigator && location.protocol.startsWith('http')){
    window.addEventListener('load',()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
  }
})();
