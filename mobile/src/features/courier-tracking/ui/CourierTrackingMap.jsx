import React from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import { Ionicons } from "@expo/vector-icons";

export function CourierTrackingMap({
  position,
  destination,
  permissionDenied,
  supported,
}) {
  if (permissionDenied || !supported) {
    return (
      <View style={styles.warning} testID="courier-map-gps-off">
        <Ionicons name="location-off" size={14} color="#fbbf24" />
        <Text style={styles.warningText}>
          Ative a localização para compartilhar sua posição.
        </Text>
      </View>
    );
  }

  const initialRegion = position
    ? {
        latitude: position.latitude,
        longitude: position.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      }
    : {
        latitude: -23.5505,
        longitude: -46.6333,
        latitudeDelta: 0.05,
        longitudeDelta: 0.05,
      };

  const region = position
    ? {
        latitude: position.latitude,
        longitude: position.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      }
    : undefined;

  return (
    <View style={styles.container} testID="courier-tracking-map">
      <MapView
        style={styles.map}
        initialRegion={initialRegion}
        region={region}
        showsUserLocation={false}
        showsMyLocationButton={false}
        pitchEnabled={false}
        rotateEnabled={false}
        scrollEnabled={true}
        zoomEnabled={true}
      >
        {position ? (
          <Marker
            coordinate={{
              latitude: position.latitude,
              longitude: position.longitude,
            }}
            title="Sua posição"
          />
        ) : null}
        {destination?.latitude != null && destination?.longitude != null ? (
          <Marker
            coordinate={{
              latitude: destination.latitude,
              longitude: destination.longitude,
            }}
            title="Endereço de entrega"
            pinColor="#fbbf24"
          />
        ) : null}
      </MapView>
      {!position ? (
        <Text style={styles.hint}>Aguardando sinal de GPS…</Text>
      ) : null}
    </View>
  );
}

export default CourierTrackingMap;

const styles = StyleSheet.create({
  container: {
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(120,113,108,0.4)",
    backgroundColor: "#1c1917",
  },
  map: {
    height: 224,
  },
  warning: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "rgba(251,191,36,0.16)",
  },
  warningText: {
    color: "#fbbf24",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  hint: {
    color: "#a8a29e",
    fontSize: 13,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
