import sys,glob
from PIL import Image
d,out=sys.argv[1],sys.argv[2]
fs=sorted(glob.glob(d+'/s_*.jpg'),key=lambda f:float(f.split('s_')[1][:-4]))
ims=[Image.open(f).resize((360,640)) for f in fs]
W=4;Hn=(len(ims)+W-1)//W
c=Image.new('RGB',(360*W,640*Hn))
for i,im in enumerate(ims):c.paste(im,((i%W)*360,(i//W)*640))
c.save(out,quality=85)
