#include <Arduino.h>

const int trigPin = 5;
const int echoPin = 18;

#define SOUND_SPEED     0.034
#define DIST_TRIGGER    5.0   // cm — dispara el SCAN
#define DIST_RESET     12.0   // cm — umbral para volver a armar el trigger

// Estados
enum Estado { ARMADO, ESPERANDO_RESET };
Estado estado = ARMADO;

float medirCm() {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long duration = pulseIn(echoPin, HIGH, 30000); // timeout 30ms (~5m max)
  if (duration == 0) return 999.0; // sin eco = objeto muy lejos o error
  return duration * SOUND_SPEED / 2.0;
}

void setup() {
  Serial.begin(115200);
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
}

void loop() {
  float dist = medirCm();

  switch (estado) {

    case ARMADO:
      if (dist < DIST_TRIGGER) {
        Serial.println("SCAN");
        estado = ESPERANDO_RESET;
      }
      break;

    case ESPERANDO_RESET:
      // Solo vuelve a armarse cuando el cono se aleja lo suficiente
      if (dist > DIST_RESET) {
        estado = ARMADO;
      }
      break;
  }

  delay(50); // 20 Hz es suficiente para un sensor HC-SR04
}
