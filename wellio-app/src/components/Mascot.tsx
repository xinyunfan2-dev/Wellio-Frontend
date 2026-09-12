import {useEffect,useRef,useState} from 'react'
type Pose='welcome'|'thinking'|'sleep'|'celebrate'|'recover'|'pace'|'ready'|'energized'|'row'|'pulldown'|'lateral'|'squat'
export function Mascot({pose='welcome',className='',alt='Wellio'}:{pose?:Pose;className?:string;alt?:string}){
 const ref=useRef<HTMLImageElement>(null),[active,setActive]=useState(false)
 const readiness=['recover','pace','ready','energized'].includes(pose),exercise=['row','pulldown','lateral','squat'].includes(pose)
 useEffect(()=>{const reduced=matchMedia('(prefers-reduced-motion: reduce)');let visible=true;const sync=()=>setActive(visible&&!document.hidden&&!reduced.matches);const observer=new IntersectionObserver(entries=>{visible=entries[0]?.isIntersecting??false;sync()});if(ref.current)observer.observe(ref.current);document.addEventListener('visibilitychange',sync);reduced.addEventListener('change',sync);sync();return()=>{observer.disconnect();document.removeEventListener('visibilitychange',sync);reduced.removeEventListener('change',sync)}},[])
 const src=readiness?`/assets/readiness/${pose}.webp`:`/assets/wellio/${pose}/${active&&exercise?'animation':'poster'}.webp`
 return <img ref={ref} className={`wellio-mascot ${active&&!exercise?'mascot-breathe':''} ${className}`} src={src} alt={alt} width="256" height="256" draggable="false"/>
}
