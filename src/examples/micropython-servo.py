# MicroPython on the RP2040: a button steps a servo through 0, 90 and 180 degrees.
# The button is on GP14 (to GND, with the pin's own pull-up); the servo's signal on GP15.
from machine import Pin, PWM
import time

led = Pin(25, Pin.OUT)
button = Pin(14, Pin.IN, Pin.PULL_UP)
servo = PWM(Pin(15))
servo.freq(50)  # a servo wants a pulse every 20 ms

def angle(deg):
    # 0.5 ms (0 degrees) to 2.5 ms (180 degrees)
    servo.duty_ns(int(500_000 + deg * 2_000_000 / 180))

angles = [0, 90, 180]
i = 1
angle(angles[i])
print("ready: press the button (click it while running)")
was = button.value()
while True:
    now = button.value()
    if was == 1 and now == 0:  # just pressed
        i = (i + 1) % len(angles)
        angle(angles[i])
        led.toggle()
        print("servo to", angles[i])
    was = now
    time.sleep_ms(20)
