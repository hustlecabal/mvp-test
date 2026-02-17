import { useVideoConfig, useCurrentFrame } from 'remotion';
import { useEffect, useState } from 'react';

export const HelloWorld: React.FC<{
  titleText: string;
  titleColor: string;
}> = ({ titleText, titleColor }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    if (frame > 30) {
      setShowText(true);
    }
  }, [frame]);

  const progress = Math.min(frame / durationInFrames, 1);

  return (
    <div
      style={{
        flex: 1,
        backgroundColor: '#1a1a2e',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: 'system-ui, sans-serif',
        position: 'relative',
      }}
    >
      {/* Animated background circle */}
      <div
        style={{
          position: 'absolute',
          width: `${200 + progress * 400}px`,
          height: `${200 + progress * 400}px`,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(162,155,254,0.3) 0%, rgba(162,155,254,0) 70%)',
          transform: 'translate(-50%, -50%)',
          top: '50%',
          left: '50%',
        }}
      />
      
      {/* Title with fade-in */}
      <div
        style={{
          fontSize: '72px',
          fontWeight: 'bold',
          color: titleColor,
          textAlign: 'center',
          opacity: showText ? 1 : 0,
          transform: showText ? 'translateY(0)' : 'translateY(30px)',
          transition: 'opacity 0.5s ease, transform 0.5s ease',
          zIndex: 1,
          padding: '0 60px',
          lineHeight: 1.2,
        }}
      >
        {titleText}
      </div>

      {/* Subtitle */}
      <div
        style={{
          fontSize: '32px',
          color: '#dfe6e9',
          marginTop: '30px',
          opacity: showText ? 0.8 : 0,
          transition: 'opacity 0.8s ease 0.2s',
          zIndex: 1,
        }}
      >
        Built by MacBovet + Opeyemi 🦉
      </div>

      {/* Progress bar */}
      <div
        style={{
          position: 'absolute',
          bottom: '60px',
          width: '60%',
          height: '8px',
          backgroundColor: 'rgba(255,255,255,0.1)',
          borderRadius: '4px',
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: '100%',
            backgroundColor: '#a29bfe',
            borderRadius: '4px',
            transition: 'width 0.1s linear',
          }}
        />
      </div>

      {/* Frame counter */}
      <div
        style={{
          position: 'absolute',
          bottom: '20px',
          right: '30px',
          fontSize: '16px',
          color: 'rgba(255,255,255,0.4)',
          fontFamily: 'monospace',
        }}
      >
        Frame: {frame}/{durationInFrames}
      </div>
    </div>
  );
};
