import jsQR from 'jsqr';
import QRCode from 'qrcode';

export async function qrCodeDataURL(value: string): Promise<string> {
  return QRCode.toDataURL(value, {
    errorCorrectionLevel: 'M',
    margin: 2,
    scale: 8,
    color: {
      dark: '#172026',
      light: '#ffffff'
    }
  });
}

export function decodeQRCodeFromCanvas(canvas: HTMLCanvasElement): string | null {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) {
    return null;
  }
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(image.data, image.width, image.height, {
    inversionAttempts: 'dontInvert'
  });
  return result?.data?.trim() || null;
}
