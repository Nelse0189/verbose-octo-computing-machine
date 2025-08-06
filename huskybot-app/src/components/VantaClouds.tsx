import { useState, useEffect, useRef } from 'react';
import * as THREE from 'three';
import CLOUDS from 'vanta/dist/vanta.clouds.min';

const VantaClouds = ({ children }) => {
  const vantaRef = useRef(null);
  const [vantaEffect, setVantaEffect] = useState(null);

  useEffect(() => {
    if (!vantaEffect && vantaRef.current) {
      const effect = CLOUDS({
        el: vantaRef.current,
        THREE: THREE,
        mouseControls: true,
        touchControls: true,
        gyroControls: false,
        minHeight: 200.00,
        minWidth: 200.00,
        skyColor: 0xa8b8d0,      // Much brighter, lighter blue-gray sky
        cloudColor: 0xf0f4f8,     // Very bright, almost white clouds
        cloudShadowColor: 0x6b7a94, // Lighter but visible shadows
        sunColor: 0x0,
        sunGlareColor: 0x0,
        sunlightColor: 0x0,
        speed: 1.00
      });
      setVantaEffect(effect);
    }
    return () => {
      if (vantaEffect) {
        (vantaEffect as any).destroy();
      }
    };
  }, []);

  return (
    <div ref={vantaRef} style={{
      width: '100vw',
      height: '100vh',
      position: 'relative',
    }}>
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 1
       }}>
        {children}
      </div>
    </div>
  );
};

export default VantaClouds; 