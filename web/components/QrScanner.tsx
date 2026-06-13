"use client";

// Thin wrapper over @yudiel/react-qr-scanner's camera Scanner, narrowed to the
// one thing the door needs: a single decoded string on a successful scan. It is
// imported with `next/dynamic({ ssr: false })` at the call site because the
// underlying camera/BarcodeDetector APIs are browser-only.

import { Scanner, type IDetectedBarcode, type IScannerError } from "@yudiel/react-qr-scanner";

export function QrScanner({
  onDecode,
  onError,
  paused,
}: {
  onDecode: (value: string) => void;
  onError?: (message: string) => void;
  paused?: boolean;
}) {
  return (
    <Scanner
      formats={["qr_code"]}
      paused={paused}
      scanDelay={400}
      onScan={(codes: IDetectedBarcode[]) => {
        const v = codes[0]?.rawValue;
        if (v) onDecode(v);
      }}
      onError={(err: IScannerError) => onError?.(err.message)}
      styles={{ container: { width: "100%", borderRadius: 12, overflow: "hidden" } }}
    />
  );
}
