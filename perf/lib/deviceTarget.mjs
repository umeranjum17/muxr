let androidSerial;

export function setAndroidSerial(serial) {
    if (typeof serial !== 'string' || serial.trim() === '') throw new Error('Android serial is required');
    androidSerial = serial.trim();
}

export function androidArgs(args) {
    return androidSerial === undefined ? [...args] : ['-s', androidSerial, ...args];
}

export function currentAndroidSerial() {
    return androidSerial;
}
