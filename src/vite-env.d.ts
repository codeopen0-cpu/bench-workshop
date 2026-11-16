/// <reference types="vite/client" />
declare module '*.ino?raw' {
  const text: string;
  export default text;
}
declare module '*.bench?raw' {
  const text: string;
  export default text;
}
