import { useEffect, useRef, useState } from 'react'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix generic Leaflet asset paths so standard popups/markers never crash in React
// @ts-expect-error Leaflet's private icon path is not in the public typings
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com',
  iconRetinaUrl: 'https://unpkg.com',
  shadowUrl: 'https://unpkg.com',
})

export interface MapPin {
  id: string
  lat: number
  lng: number
  label?: string
}

export interface MapAccuracyCircle {
  lat: number
  lng: number
  radiusM: number
}

interface LeafletMapProps {
  pins: MapPin[]
  center?: [number, number]
  zoom?: number
  height?: string
  onPinClick?: (id: string) => void
  onMapClick?: (lat: number, lng: number) => void
  selectedId?: string | null
  showLayerToggle?: boolean
  defaultLayer?: MapBaseLayer
  accuracyCircle?: MapAccuracyCircle | null
}

export type MapBaseLayer = 'street' | 'satellite'

export const MORMUGAO_CENTER: [number, number] = [15.4006, 73.815]
export const MORMUGAO_BOUNDS = L.latLngBounds(
  [15.32, 73.74],
  [15.48, 73.96],
)

const CARTO = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
const CARTO_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ESRI_LABELS =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
const ESRI_ROADS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'
const ESRI_ATTR = 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS'

function housePinIcon(selected: boolean): L.DivIcon {
  const fill = selected ? '#f59e0b' : '#0284c7'
  const stroke = selected ? '#b45309' : '#075985'
  return L.divIcon({
    className: 'voter-house-pin',
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">
      <path d="M17 1.5C8.7 1.5 2 8.2 2 16.5c0 10.4 15 26 15 26s15-15.6 15-26C32 8.2 25.3 1.5 17 1.5Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
      <path d="M17 9.5 9.5 15.5V26h4.8v-5.5h5.4V26h4.8V15.5L17 9.5Z" fill="#ffffff"/>
    </svg>`,
    iconSize: [34, 44],
    iconAnchor: [17, 44],
    tooltipAnchor: [0, -36],
  })
}

export function LeafletMap({
  pins,
  center,
  zoom = 14,
  height = '16rem',
  onPinClick,
  onMapClick,
  selectedId,
  showLayerToggle = true,
  defaultLayer = 'street',
  accuracyCircle = null,
}: LeafletMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const accuracyRef = useRef<L.LayerGroup | null>(null)
  const streetRef = useRef<L.TileLayer | null>(null)
  const satelliteRef = useRef<L.LayerGroup | null>(null)
  const onPinClickRef = useRef(onPinClick)
  const onMapClickRef = useRef(onMapClick)
  const [baseLayer, setBaseLayer] = useState<MapBaseLayer>(defaultLayer)

  useEffect(() => {
    onPinClickRef.current = onPinClick
    onMapClickRef.current = onMapClick
  }, [onPinClick, onMapClick])

  useEffect(() => {
    setBaseLayer(defaultLayer)
  }, [defaultLayer])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      minZoom: 12,
      maxZoom: 21,
      maxBounds: MORMUGAO_BOUNDS,
      maxBoundsViscosity: 0.7,
    })

    const street = L.tileLayer(CARTO, {
      attribution: CARTO_ATTR,
      subdomains: 'abcd',
      maxZoom: 21,
      maxNativeZoom: 20,
    })
    const imagery = L.tileLayer(ESRI_IMAGERY, {
      attribution: ESRI_ATTR,
      maxZoom: 21,
      maxNativeZoom: 19,
    })
    const labels = L.tileLayer(ESRI_LABELS, { maxZoom: 21, maxNativeZoom: 19 })
    const roads = L.tileLayer(ESRI_ROADS, { maxZoom: 21, maxNativeZoom: 19 })
    const satellite = L.layerGroup([imagery, labels, roads])

    street.addTo(map)
    streetRef.current = street
    satelliteRef.current = satellite

    layerRef.current = L.layerGroup().addTo(map)
    accuracyRef.current = L.layerGroup().addTo(map)
    map.setView(center ?? MORMUGAO_CENTER, zoom)

    map.on('click', (event: L.LeafletMouseEvent) => {
      onMapClickRef.current?.(event.latlng.lat, event.latlng.lng)
    })

    mapRef.current = map

    // Fix timing/rendering gaps within modern flex/grid parent containers
    const frame = window.requestAnimationFrame(() => map.invalidateSize())
    const timer = window.setTimeout(() => map.invalidateSize(), 250)

    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      map.remove()
      mapRef.current = null
      layerRef.current = null
      accuracyRef.current = null
      streetRef.current = null
      satelliteRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const street = streetRef.current
    const satellite = satelliteRef.current
    if (!map || !street || !satellite) return

    if (baseLayer === 'satellite') {
      if (map.hasLayer(street)) map.removeLayer(street)
      if (!map.hasLayer(satellite)) satellite.addTo(map)
    } else {
      if (map.hasLayer(satellite)) map.removeLayer(satellite)
      if (!map.hasLayer(street)) street.addTo(map)
    }
  }, [baseLayer])

  useEffect(() => {
    const layer = accuracyRef.current
    if (!layer) return
    layer.clearLayers()
    if (!accuracyCircle) return
    L.circle([accuracyCircle.lat, accuracyCircle.lng], {
      radius: Math.max(accuracyCircle.radiusM, 1),
      color: '#0284c7',
      weight: 1.5,
      fillColor: '#38bdf8',
      fillOpacity: 0.15,
      interactive: false,
    }).addTo(layer)
  }, [accuracyCircle])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()

    for (const pin of pins) {
      const marker = L.marker([pin.lat, pin.lng], {
        icon: housePinIcon(pin.id === selectedId),
      })

      if (pin.label) {
        marker.bindTooltip(pin.label, {
          direction: 'top',
          permanent: false,
        })
      }

      marker.on('click', (event: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(event)
        onPinClickRef.current?.(pin.id)
      })
      marker.addTo(layer)
    }

    if (center) {
      map.setView(center, zoom)
    } else if (pins.length === 1) {
      map.setView([pins[0].lat, pins[0].lng], Math.max(zoom, 16))
    } else if (pins.length > 1) {
      const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number]))
      map.fitBounds(bounds.pad(0.2), { maxZoom: 17 })
    } else {
      map.setView(MORMUGAO_CENTER, zoom)
    }
    map.invalidateSize()
  }, [pins, center, zoom, selectedId])

  return (
    <div className="relative w-full">
      <div
        ref={containerRef}
        className="w-full overflow-hidden rounded-xl border border-line"
        style={{ height }}
      />
      {showLayerToggle ? (
        <div className="absolute right-2 top-2 z-[400] flex overflow-hidden rounded-lg border border-line bg-white text-xs font-semibold shadow-md">
          <button
            type="button"
            className={`px-2.5 py-1.5 transition-colors ${baseLayer === 'street' ? 'bg-brand-600 text-white' : 'text-ink-secondary hover:bg-muted'}`}
            onClick={() => setBaseLayer('street')}
          >
            Street
          </button>
          <button
            type="button"
            className={`px-2.5 py-1.5 transition-colors ${baseLayer === 'satellite' ? 'bg-brand-600 text-white' : 'text-ink-secondary hover:bg-muted'}`}
            onClick={() => setBaseLayer('satellite')}
          >
            Satellite
          </button>
        </div>
      ) : null}
    </div>
  )
}
