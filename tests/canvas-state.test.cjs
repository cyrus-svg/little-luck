const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual page renderer against a Canvas state/affine-transform model.
// In particular, assigning either bitmap dimension resets the drawing state,
// even when assigning its existing value (HTML canvas specification).
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1].replace(
  /\}\)\(\);\s*$/,
  'globalThis.rendererTest={play,frame,resize,setClock(t){sceneTime=t},effects(){comets=[{x:70,y:90,age:0}];burst(150,250,12,.4,true)}};})();',
);

function multiply(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}

function harness(dpr, reduced = false) {
  let state, stack = [], underflows = 0, fills = [], clears = [], callbacks = [], now = 0;
  const reset = () => { state = {matrix:[1,0,0,1,0,0], globalAlpha:1}; stack = []; };
  reset();
  const operations = {
    save() { stack.push({...state, matrix:[...state.matrix]}); },
    restore() { if (stack.length) state = stack.pop(); else underflows++; },
    setTransform(...m) { state.matrix = m; },
    translate(x,y) { state.matrix = multiply(state.matrix,[1,0,0,1,x,y]); },
    scale(x,y) { state.matrix = multiply(state.matrix,[x,0,0,y,0,0]); },
    rotate(a) { const c=Math.cos(a),s=Math.sin(a); state.matrix=multiply(state.matrix,[c,s,-s,c,0,0]); },
    fillRect(x,y,w,h) { fills.push({x,y,w,h,matrix:[...state.matrix]}); },
    clearRect(x,y,w,h) { clears.push({x,y,w,h,matrix:[...state.matrix]}); },
    createLinearGradient() { return {addColorStop(){}}; },
    createRadialGradient() { return {addColorStop(){}}; },
  };
  const ctx = new Proxy({}, {
    get: (_,key) => key in operations ? operations[key] : key in state ? state[key] : () => {},
    set: (_,key,value) => { state[key]=value; return true; },
  });
  const elements = new Map();
  const element = id => {
    if (elements.has(id)) return elements.get(id);
    const classes = new Set();
    const el = {id,style:{},value:'',textContent:'',hidden:false,
      classList:{add(...xs){xs.forEach(x=>classes.add(x));},remove(...xs){xs.forEach(x=>classes.delete(x));},toggle(x,on){on?classes.add(x):classes.delete(x);}},
      setAttribute(){},addEventListener(){},hasPointerCapture(){return false;},releasePointerCapture(){},
    };
    elements.set(id,el); return el;
  };
  const canvas = element('universe');
  let width=300,height=150;
  Object.defineProperties(canvas, {
    width:{get:()=>width,set:v=>{width=v;reset();}},
    height:{get:()=>height,set:v=>{height=v;reset();}},
  });
  canvas.getContext=()=>ctx;
  element('gift-data').textContent=html.match(/id="gift-data">([\s\S]*?)<\/script>/)[1];
  const document={hidden:false,documentElement:{outerHTML:html},body:element('body'),querySelector:s=>element(s.slice(1)),addEventListener(){}};
  const env={document,innerWidth:390,innerHeight:844,devicePixelRatio:dpr,
    performance:{now:()=>now},matchMedia:()=>({matches:reduced}),
    requestAnimationFrame:fn=>callbacks.push(fn),addEventListener(){},setTimeout(){},clearTimeout(){},console};
  vm.createContext(env); vm.runInContext(source,env);
  const api=env.rendererTest;
  function step() {
    fills=[]; clears=[]; callbacks=[]; now+=16; api.frame(now);
    assert.equal(callbacks.length,1,'each frame schedules exactly one successor');
  }
  function assertHealthy(label) {
    assert.equal(underflows,0,label+': no restore on an empty stack');
    assert.equal(stack.length,0,label+': drawing functions balance their saved states');
    assert.equal(clears.length,1,label+': clear the complete previous frame once');
    assert.deepEqual(clears[0],{x:0,y:0,w:canvas.width,h:canvas.height,matrix:[1,0,0,1,0,0]},
      label+': clear every backing-store pixel in identity coordinates');
    const baseline=[canvas.width/env.innerWidth,0,0,canvas.height/env.innerHeight,0,0];
    state.matrix.forEach((v,i)=>assert.ok(Math.abs(v-baseline[i])<1e-8,label+': CTM component '+i));
    const bg=fills[0];
    assert.equal(bg.x,0); assert.equal(bg.y,0);
    assert.equal(bg.w,env.innerWidth); assert.equal(bg.h,env.innerHeight);
    assert.ok(Math.abs(bg.w*bg.matrix[0]-canvas.width)<1e-8,label+': background covers bitmap width');
    assert.ok(Math.abs(bg.h*bg.matrix[3]-canvas.height)<1e-8,label+': background covers bitmap height');
  }
  return {api,canvas,ctx,env,step,assertHealthy,reset,
    resize(w,h){env.innerWidth=w;env.innerHeight=h;api.resize();},
    metrics:()=>({matrix:[...state.matrix],depth:stack.length,underflows,background:fills[0]}),
  };
}

for (const dpr of [1,2,3]) for (const reduced of [false,true]) {
  test(`balanced drawing states at DPR ${dpr}, reduced=${reduced}`,()=>{
    const h=harness(dpr,reduced);
    for (let hat=0;hat<4;hat++) for (const patAge of [-1,0,.1,.25,.7,1.19,1.3]) {
      h.api.play.hat=hat; h.api.setClock(2); h.api.play.patAt=2-patAge;
      h.step();h.assertHealthy(`hat ${hat}, pat ${patAge}`);
    }
    h.api.play.shyUntil=20;h.api.effects();
    h.step();h.assertHealthy('shy pose and particles');
    for (let hat=0;hat<4;hat++) {
      h.api.play.hat=hat;h.api.play.flight={at:10};
      for(const age of [0,.2,1,2.5,4.7,5.1]) {
        h.api.setClock(10+age);h.step();h.assertHealthy('UFO '+age);
      }
    }
    // Browser resize events run between synchronous drawing tasks, not midway
    // through a save/restore pair. Exercise portrait/landscape and DPR changes.
    h.resize(844,390);h.step();h.assertHealthy('landscape resize');
    h.env.devicePixelRatio=1;h.resize(390,844);h.step();h.assertHealthy('DPR change');
  });
}

for(const dpr of [1,2,3]) {
  test(`renderer recovers a reset canvas state at DPR ${dpr}`,()=>{
    const h=harness(dpr);h.step();h.assertHealthy('before reset');
    h.canvas.width=h.canvas.width; // standards-defined reset of CTM + state stack
    assert.deepEqual(h.metrics().matrix,[1,0,0,1,0,0]);
    h.step();h.assertHealthy('first frame after backing-store reset');
  });
}
