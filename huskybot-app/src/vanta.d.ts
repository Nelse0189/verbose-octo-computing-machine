interface VantaEffect {
  destroy: () => void;
}

declare module 'vanta/dist/vanta.fog.min' {
  function FOG(options: {
    el: HTMLElement | null;
    THREE: any;
    [key: string]: any;
  }): {
    destroy: () => void;
  };
  export default FOG;
} 