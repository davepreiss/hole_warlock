import { getOC } from "./occt-node.mjs";
const oc = await getOC(); oc.STEPControl_Controller.Init();
const SHAPE=oc.TopAbs_ShapeEnum.TopAbs_SHAPE, FACE=oc.TopAbs_ShapeEnum.TopAbs_FACE, SOLID=oc.TopAbs_ShapeEnum.TopAbs_SOLID;
const cylV=oc.GeomAbs_SurfaceType.GeomAbs_Cylinder?.value??oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;
const outVal=oc.TopAbs_State?.TopAbs_OUT?.value??oc.TopAbs_State?.TopAbs_OUT;
function cut(a,b){ const c=new oc.BRepAlgoAPI_Cut_3(a,b); c.Build?.(); return c.Shape(); }
function cyl(x,y,z,r,h,dz=1){ const ax=new oc.gp_Ax2_3(new oc.gp_Pnt_3(x,y,z), new oc.gp_Dir_4(0,0,dz)); return new oc.BRepPrimAPI_MakeCylinder_3(ax,r,h).Shape(); }
const block = new oc.BRepPrimAPI_MakeBox_1(40,40,10).Shape();
// through hole at (10,20) full depth 10; blind hole at (30,20) depth 6 from top (z=10 down)
let s = cut(block, cyl(10,20,-1,3,12));               // through (spans -1..11)
s = cut(s, cyl(30,20,4,3,10));                        // blind: from z=4 up to 14 (covers top), bottom at z=4 => material below
new oc.BRepMesh_IncrementalMesh_2(s,0.1,false,0.5,false);
let solid=s; const se=new oc.TopExp_Explorer_2(s,SOLID,SHAPE); if(se.More()) solid=oc.TopoDS.Solid_1(se.Current());
const cl=new oc.BRepClass3d_SolidClassifier_2(solid);
const exp=new oc.TopExp_Explorer_2(s,FACE,SHAPE); let fid=0;
for(;exp.More();exp.Next(),fid++){
  let sa; try{sa=new oc.BRepAdaptor_Surface_2(oc.TopoDS.Face_1(exp.Current()),true);}catch{continue;}
  const tv=sa.GetType()?.value??sa.GetType(); if(tv!==cylV)continue;
  const c=sa.Cylinder(), r=c.Radius(), ll=c.Axis().Location(), dd=c.Axis().Direction();
  const u0=sa.FirstUParameter(),u1=sa.LastUParameter(),v0=sa.FirstVParameter(),v1=sa.LastVParameter(),uM=(u0+u1)/2;
  if(u1-u0<1.9*Math.PI)continue;
  const pa=sa.Value(uM,v0),pb=sa.Value(uM,v1);
  // project ends onto axis
  const loc=[ll.X(),ll.Y(),ll.Z()],dir=[dd.X(),dd.Y(),dd.Z()];
  const foot=(p)=>{const t=(p[0]-loc[0])*dir[0]+(p[1]-loc[1])*dir[1]+(p[2]-loc[2])*dir[2];return[loc[0]+dir[0]*t,loc[1]+dir[1]*t,loc[2]+dir[2]*t];};
  const A=foot([pa.X(),pa.Y(),pa.Z()]),B=foot([pb.X(),pb.Y(),pb.Z()]);
  const rim = A[2]>=B[2]?A:B, bot = A[2]>=B[2]?B:A;     // rim = top (max z)
  const dv=[bot[0]-rim[0],bot[1]-rim[1],bot[2]-rim[2]],dl=Math.hypot(...dv)||1,eps=Math.max(0.2,r*0.5);
  const tp=new oc.gp_Pnt_3(bot[0]+dv[0]/dl*eps,bot[1]+dv[1]/dl*eps,bot[2]+dv[2]/dl*eps);
  cl.Perform(tp,1e-6); const st=cl.State(); const through=(st?.value??st)===outVal;
  console.log(`cyl r=${r.toFixed(1)} center≈(${rim[0].toFixed(0)},${rim[1].toFixed(0)}) bottomZ=${bot[2].toFixed(1)} -> ${through?'THROUGH':'BLIND'}`);
}
console.log("DONE");
