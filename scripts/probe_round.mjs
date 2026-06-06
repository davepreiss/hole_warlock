import { getOC } from "./occt-node.mjs";
const oc = await getOC();
oc.STEPControl_Controller.Init();
const cylVal = oc.GeomAbs_SurfaceType.GeomAbs_Cylinder?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;
const coneVal = oc.GeomAbs_SurfaceType.GeomAbs_Cone?.value ?? oc.GeomAbs_SurfaceType.GeomAbs_Cone;
const SHAPE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE, FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
const foot=(p,l,d)=>{const t=(p[0]-l[0])*d[0]+(p[1]-l[1])*d[1]+(p[2]-l[2])*d[2];return [l[0]+d[0]*t,l[1]+d[1]*t,l[2]+d[2]*t];};
const rad=(p,l,d)=>{const f=foot(p,l,d);return Math.hypot(p[0]-f[0],p[1]-f[1],p[2]-f[2]);};
function run(label, shape){
  new oc.BRepMesh_IncrementalMesh_2(shape,0.1,false,0.5,false);
  const exp=new oc.TopExp_Explorer_2(shape,FACE,SHAPE);let n=0;
  for(;exp.More();exp.Next()){
    let sa;try{sa=new oc.BRepAdaptor_Surface_2(oc.TopoDS.Face_1(exp.Current()),true);}catch{continue;}
    const tv=sa.GetType()?.value??sa.GetType(); if(tv!==cylVal&&tv!==coneVal)continue;
    const u0=sa.FirstUParameter(),u1=sa.LastUParameter(); if(u1-u0<1.9*Math.PI)continue;
    const v0=sa.FirstVParameter(),v1=sa.LastVParameter(),uMid=(u0+u1)/2;
    const ax=(tv===cylVal?sa.Cylinder():sa.Cone()).Axis();const dd=ax.Direction(),ll=ax.Location();
    const dl=Math.hypot(dd.X(),dd.Y(),dd.Z())||1;const dir=[dd.X()/dl,dd.Y()/dl,dd.Z()/dl],loc=[ll.X(),ll.Y(),ll.Z()];
    const pa=sa.Value(uMid,v0),pb=sa.Value(uMid,v1);const pav=[pa.X(),pa.Y(),pa.Z()],pbv=[pb.X(),pb.Y(),pb.Z()];
    const a=foot(pav,loc,dir),b=foot(pbv,loc,dir),ra=rad(pav,loc,dir),rb=rad(pbv,loc,dir);n++;
    console.log(`  ${label} round#${n}: axis[${dir.map(x=>x.toFixed(2))}] a[${a.map(x=>x.toFixed(1))}] b[${b.map(x=>x.toFixed(1))}] ra=${ra.toFixed(2)} rb=${rb.toFixed(2)}`);
  }
  console.log(`${label}: ${n} full round face(s)`);
}
run("cylinder(r8,h20)", new oc.BRepPrimAPI_MakeCylinder_1(8,20).Shape());
run("cone(r8->0,h20)", new oc.BRepPrimAPI_MakeCone_1(8,0,20).Shape());
run("box", new oc.BRepPrimAPI_MakeBox_1(40,40,20).Shape());
console.log("DONE");
