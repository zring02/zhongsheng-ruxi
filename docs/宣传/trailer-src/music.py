import numpy as np, wave
from scipy.signal import lfilter, butter, fftconvolve, sosfilt
SR=44100; DUR=59.5; N=int(SR*DUR)
L=np.zeros(N); R=np.zeros(N)
rng=np.random.default_rng(3)
def T(t): return int(t*SR)
def add(sig,t,gain=1.0,pan=0.0,raw=False):
    if not raw and t>=26.6: t+=1.5
    i=T(t); j=min(N,i+len(sig))
    if j<=i: return
    s=sig[:j-i]*gain
    L[i:j]+=s*np.sqrt((1-pan)/2); R[i:j]+=s*np.sqrt((1+pan)/2)
def env(n,a,d,curve=4):
    t=np.arange(n)/SR; e=np.minimum(1,t/max(a,1e-4))*np.exp(-t*curve/max(d,1e-3)); return e
def lp(x,fc,o=2): return sosfilt(butter(o,fc/(SR/2),'low',output='sos'),x)
def hp(x,fc,o=2): return sosfilt(butter(o,fc/(SR/2),'high',output='sos'),x)
def bp(x,lo,hi,o=2): return sosfilt(butter(o,[lo/(SR/2),hi/(SR/2)],'band',output='sos'),x)
def noise(d): return rng.standard_normal(int(d*SR))
def saw(f,d,det=0.0):
    t=np.arange(int(d*SR))/SR; return 2*((t*f*(1+det))%1)-1
def note(n): return 440*2**((n-69)/12)

# ---------- instruments ----------
def taiko(big=1.0):
    d=1.2; n=int(d*SR); t=np.arange(n)/SR
    f=48+70*np.exp(-t*30); ph=2*np.pi*np.cumsum(f)/SR
    s=np.sin(ph)*np.exp(-t*(5/big))
    s+=lp(noise(d),900)*np.exp(-t*40)*.6
    return s*big
def impact(d=3.5):
    n=int(d*SR); t=np.arange(n)/SR
    f=30+90*np.exp(-t*12); s=np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-t*1.4)
    s+=lp(noise(d),2500)*np.exp(-t*6)*.9
    s+=np.sin(2*np.pi*34*t)*np.exp(-t*.9)*.6
    return s
def whoosh(d=.6,lo=300,hi=4000,rev=False):
    x=noise(d); n=len(x); out=np.zeros(n); seg=n//24
    for k in range(24):
        a,b=k*seg,(k+1)*seg if k<23 else n
        fr=k/23 if not rev else 1-k/23
        c=lo*(hi/lo)**fr
        out[a:b]=bp(x,max(40,c*.6),min(SR/2-100,c*1.6))[a:b]
    e=np.sin(np.linspace(0,np.pi,n))**2
    return out*e
def riser(d=2.0):
    n=int(d*SR); t=np.arange(n)/SR
    x=whoosh(d,200,8000)*(t/d)**2*1.4
    f=200*2**(t/d*2.5); x+=np.sin(2*np.pi*np.cumsum(f)/SR)*(t/d)**3*.25
    return x
def tick():
    d=.05; t=np.arange(int(d*SR))/SR; return hp(noise(d),3000)*np.exp(-t*160)*.7
def click():
    d=.03; t=np.arange(int(d*SR))/SR; return bp(noise(d),1500,6000)*np.exp(-t*250)*.6
def pop(f=880):
    d=.18; t=np.arange(int(d*SR))/SR; ff=f*(1+1.2*np.exp(-t*40)); return np.sin(2*np.pi*np.cumsum(ff)/SR)*np.exp(-t*22)
def heart():
    d=.35; t=np.arange(int(d*SR))/SR; return np.sin(2*np.pi*55*t)*np.exp(-t*18)
def pad(notes,d,bright=1200,gain=.12):
    s=np.zeros(int(d*SR))
    for n_ in notes:
        for det in (-.004,0,.005):
            s+=saw(note(n_),d,det)
    s=lp(s,bright,2); n=len(s); a=int(.35*SR)
    e=np.ones(n); e[:a]=np.linspace(0,1,a); e[-a:]=np.linspace(1,0,a)
    return s*e*gain
def brass(notes,d,gain=.16):
    s=np.zeros(int(d*SR)); t=np.arange(len(s))/SR
    for n_ in notes:
        for det in (-.003,.003): s+=saw(note(n_),d,det)
    s=lp(s,1800,2)*np.minimum(1,t/.04)*np.exp(-t*1.2)
    return s*gain
def pluck(f,d=1.6,bright=.5):
    n=int(d*SR); p=int(SR/f); buf=rng.uniform(-1,1,p); out=np.zeros(n)
    for i in range(n):
        out[i]=buf[i%p]; buf[i%p]=.996*(bright*buf[i%p]+(1-bright)*buf[(i+1)%p]) if True else 0
    return out*np.exp(-np.arange(n)/SR*1.5)
def boomf():  # firework
    d=1.0; t=np.arange(int(d*SR))/SR
    return lp(noise(d),1800)*np.exp(-t*7)*.8+bp(noise(d),3000,9000)*np.exp(-t*3)*.25*(rng.random(int(d*SR))>.97)

# ---------- score ----------
B=.5
# 0-4 hook: drone + heartbeat + ticks + typing + stamp
t=np.arange(T(4.2))/SR
drone=(np.sin(2*np.pi*36.7*t)+.5*np.sin(2*np.pi*73.4*t+1)+.25*lp(saw(36.7*2,4.2),300))*np.minimum(1,t/.4)
add(drone,0,.35)
for k in range(8): add(heart(),k*.5,.6); add(tick(),k*.5+.25,.35)
for k in range(17): add(click(),.08+k*.045+rng.random()*.01,.45,rng.uniform(-.3,.3))
for k in range(13): add(click(),1.0+k*.06+rng.random()*.015,.5,rng.uniform(-.3,.3))
add(impact(2.2),1.75,.7); add(taiko(1.4),1.75,.6); add(whoosh(.5,2000,400,True),1.6,.4)
add(whoosh(.8,200,5000),2.25,.6,-.4)
add(riser(1.4),2.6,.7)
# 4.0 main theme D minor: Dm Bb F C
prog=[[50,53,57,62],[46,50,53,58],[41,45,48,53],[48,52,55,60]]
def theme(t0,t1,drums='full',chord_len=2.0,start_i=0,bright=1400,pad_gain=.12):
    i=start_i; tt=t0
    while tt<t1-1e-6:
        d=min(chord_len,t1-tt); c=prog[i%4]
        add(pad([n-12 for n in c]+c,d+.3,bright,pad_gain),tt,1,0)
        add(brass(c[1:],min(.9,d),.1),tt,1,.2)
        # ostinato strings 8ths
        for k in range(int(d/(B/2))):
            nn=c[k%4]+12; add(lp(saw(note(nn),.22),2600)*env(int(.22*SR),.005,.18,3)*.05,tt+k*B/2,1,-.3+.6*(k%2))
        tt+=d; i+=1
    if drums:
        b=t0
        while b<t1-1e-6:
            beat=round((b-t0)/B)
            add(taiko(1.0 if beat%4==0 else .7),b,.75 if beat%4==0 else .5,(-.2 if beat%2 else .2))
            if drums=='full' and beat%2==1: add(taiko(.5),b+B/2,.35,.3)
            if drums=='double': add(taiko(.45),b+B/2,.35,-.3); add(tick(),b+B/4,.2); add(tick(),b+3*B/4,.2)
            b+=B
add(impact(),4.0,1.0); add(taiko(1.6),4.0,.9)
theme(4.0,9.5,'full')
for i in range(5): add(pop(700+i*120),9.5+.3+i*.45,.35,-.5+i*.25)
theme(9.5,15.0,'full',start_i=3)
for b in (12.9,13.4,13.9): add(pop(520),b,.25)
# 15-25 cuts: double-time
theme(15.0,25.0,'double',chord_len=2.0,bright=1800)
for k in range(5):
    tc=15+k*2; add(whoosh(.45,400,6000),tc-.3,.5,(-1)**k*.5); add(impact(1.6),tc,.45)
add(impact(1.5),20.05,.6); add(taiko(1.5),20.05,.7)   # caught stealing
for k in range(3): add(pop(600+k*200),23.15+k*.6,.3)
# 25-27 betrayal slow-mo
t=np.arange(T(2.2))/SR; add(lp(saw(note(38),2.2)+saw(note(38),2.2,.006),500)*np.exp(-t*.6)*.25,25.0)
add(whoosh(1.0,3000,200,True),25.0,.5)
add(impact(2.5),25.9,1.0); add(taiko(1.8),25.9,.8)
add(riser(1.0),26.0,.7)
# 27-36 worlds: hit every 1.8
add(impact(),27.0,.9)
for k in range(5):
    tw=27+k*1.8; add(whoosh(.4,500,7000),tw-.25,.45,(-1)**k*.6); add(taiko(1.5),tw,.8); add(brass([62,65,69] if k%2==0 else [58,62,65],1.2,.18),tw)
theme(27.0,36.0,'full',chord_len=1.8,bright=2200,pad_gain=.14)
# 36-41.5 honglou: guzheng pentatonic + soft pad
add(whoosh(1.2,4000,300,True),35.6,.4)
add(pad([50,57,62,66],5.8,1000,.1),36.0)
pent=[62,64,66,69,71,74,76,78,81]
seq=[(36.2,74),(36.45,71),(36.7,69),(37.2,66),(37.7,69),(38.2,74),(38.35,76),(38.5,78),(39.2,81),(39.7,78),(40.2,74),(40.7,69),(41.0,66)]
for tt,n_ in seq: add(pluck(note(n_),1.4,.55),tt,.6,rng.uniform(-.4,.4))
for k in range(9): add(click(),38.5+k*.09,.25)
# 41.5-50 build
add(riser(1.0),40.5,.6); add(impact(),41.5,.8)
theme(41.5,50.0,'full',chord_len=2.0,bright=1600,pad_gain=.13)
rain=lp(noise(3.3),5000)*.18; rain*=np.minimum(1,np.arange(len(rain))/SR/.3)*np.minimum(1,(len(rain)/SR-np.arange(len(rain))/SR)/.4); add(rain,41.5,1.0)
def thunder():
    d=3.0; t=np.arange(int(d*SR))/SR
    return (hp(noise(.15),800)*np.exp(-np.arange(int(.15*SR))/SR*25)).tolist() and np.concatenate([hp(noise(.15),800)*np.exp(-np.arange(int(.15*SR))/SR*25),np.zeros(int(d*SR)-int(.15*SR))])+lp(noise(d),180)*np.exp(-t*1.1)*1.6
for tb in (41.85,42.95,43.8): add(thunder(),tb,.8,rng.uniform(-.5,.5)); add(impact(2.0),tb,.4)
add(whoosh(1.0,300,3000),44.4,.5)
for k in range(16): add(click(),45.0+k*.11,.18)
add(whoosh(.7,200,6000),47.55,.6,.6)
add(riser(2.4),47.6,.9)
# 50 final
add(impact(4.5),50.0,1.1); add(taiko(2.0),50.0,1.0)
for tb in (50.05,50.5,50.9,53.3,53.7): add(boomf(),tb,.55,rng.uniform(-.6,.6))
theme(50.0,56.0,'full',chord_len=2.0,bright=2000,pad_gain=.15)
add(impact(3.0),53.1,.7); add(brass([62,65,69,74],2.5,.2),53.1)
add(pad([50,57,62,65,69],4.0,1200,.12),55.6)
add(taiko(1.8),56.0,.8)

# insert 27-28.5 (prototype slice), raw times
add(impact(2.0),27.0,.55,raw=True); add(pad([50,57,62,65],1.7,900,.1),27.0,raw=True)
for k,tb in enumerate((27.1,27.8)): add(pop(900+k*200),tb,.35,raw=True); add(whoosh(.35,800,6000),tb-.1,.3,raw=True)
for k in range(6): add(tick(),27.0+k*.25,.3,raw=True)
# ---------- master ----------
irn=int(2.4*SR); ir=rng.standard_normal(irn)*np.exp(-np.arange(irn)/SR*2.6); ir=lp(ir,5000); ir/=np.abs(ir).sum()/30
wetL=fftconvolve(L,ir)[:N]; wetR=fftconvolve(R,ir[::-1].copy()*.98)[:N]
L2=L+wetL*.25; R2=R+wetR*.25
# glue: soft clip
mx=max(np.abs(L2).max(),np.abs(R2).max())
L2/=mx/1.6; R2/=mx/1.6
L2=np.tanh(L2); R2=np.tanh(R2)
fade=np.ones(N); fo=T(1.8); fade[-fo:]=np.linspace(1,0,fo)**2; fi=T(.05); fade[:fi]=np.linspace(0,1,fi)
L2*=fade*.92; R2*=fade*.92
st=np.stack([L2,R2],1); st=(st*32767).astype(np.int16)
with wave.open('music.wav','wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(st.tobytes())
print('ok', np.abs(st).max())
