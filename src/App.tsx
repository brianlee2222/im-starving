import { useEffect, useMemo, useRef, useState } from "react";

/**
 * I'm Starving — a tiny app that picks a random restaurant from your dataset.
 * A Google Maps export ships in `public/places.json`, and the app loads it on startup.
 */

// --- Types that match your dataset shape (best-effort, with fallbacks) ---
export type Place = {
  title?: string;
  imageUrl?: string;
  totalScore?: number; // e.g., 4.5
  reviewsCount?: number; // e.g., 123
  categoryName?: string; // e.g., "Chinese restaurant"
  street?: string;
  city?: string;
  state?: string | null;
  countryCode?: string;
  phone?: string;
  website?: string;
  url?: string; // Google Maps place URL
  [k: string]: any;
};

const STORAGE_KEY_PREFIX = "im-starving:visited";
const DATASET_STORAGE_KEY = "im-starving:selected-dataset";

const DATASETS = [
  { id: "singapore", label: "Singapore", path: "/places-singapore.json" },
  { id: "hong-kong", label: "Hong Kong", path: "/places-hongkong.json" },
] as const;

type DatasetId = (typeof DATASETS)[number]["id"];
const DEFAULT_DATASET_ID: DatasetId = "singapore";

type Coordinates = { lat: number; lng: number };

function storageKey(datasetId: DatasetId) {
  return `${STORAGE_KEY_PREFIX}:${datasetId}`;
}

function placeKey(place: Place, index: number) {
  const byUrl = place.url;
  if (byUrl) return byUrl;
  const byTitle = place.title ? `${place.title}::${place.street ?? ""}` : undefined;
  return byTitle ?? `index-${index}`;
}

function buildAddress(place: Place) {
  return [place.street, place.city, place.state ?? undefined, place.countryCode].filter(Boolean).join(", ");
}

function haversineDistance(a: Coordinates, b: Coordinates) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + sinLng * sinLng * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

function formatDistance(km: number) {
  if (km < 1) return `${(km * 1000).toFixed(0)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${km.toFixed(0)} km`;
}

export default function App() {
  const [datasetId, setDatasetId] = useState<DatasetId>(() => {
    if (typeof window === "undefined") return DEFAULT_DATASET_ID;
    const stored = window.localStorage.getItem(DATASET_STORAGE_KEY);
    return DATASETS.some((option) => option.id === stored) ? (stored as DatasetId) : DEFAULT_DATASET_ID;
  });
  const [data, setData] = useState<Place[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const [currentIdx, setCurrentIdx] = useState<number | null>(null);
  const [selectionSource, setSelectionSource] = useState<"hero" | "list" | null>(null);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [geoCache, setGeoCache] = useState<Record<string, Coordinates>>({});
  const [userLocation, setUserLocation] = useState<Coordinates | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [geolocating, setGeolocating] = useState(false);
  const [locationStatus, setLocationStatus] = useState<"idle" | "pending" | "granted" | "denied">("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [datasetInfo, setDatasetInfo] = useState<{ total: number; lastUpdated?: Date } | null>(null);
  const datasetMeta = useMemo(
    () => DATASETS.find((option) => option.id === datasetId) ?? DATASETS[0],
    [datasetId]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DATASET_STORAGE_KEY, datasetId);
  }, [datasetId]);

  useEffect(() => {
    let cancelled = false;

    async function loadDataset() {
      try {
        setLoading(true);
        const res = await fetch(datasetMeta.path, { cache: "no-cache" });
        if (!res.ok) throw new Error(`Failed to load dataset (status ${res.status})`);
        const raw = await res.json();
        const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
        if (!Array.isArray(arr) || !arr.length) throw new Error("Dataset is empty or invalid.");
        if (cancelled) return;
        const storedKeysRaw =
          typeof window !== "undefined" ? window.localStorage.getItem(storageKey(datasetId)) : null;
        let storedKeys: string[] = [];
        if (storedKeysRaw) {
          try {
            const parsed = JSON.parse(storedKeysRaw);
            if (Array.isArray(parsed)) storedKeys = parsed.filter((v) => typeof v === "string");
          } catch {
            // ignore invalid storage
          }
        }
        const storedSet = new Set(storedKeys);
        const nextVisited = new Set<string>();
        const nextCoords: Record<string, Coordinates> = {};
        let freshest: Date | undefined;
        arr.forEach((place, idx) => {
          const key = placeKey(place, idx);
          if (storedSet.has(key)) nextVisited.add(key);
          const location = (place as any).location;
          if (location && typeof location === "object") {
            const lat = Number(location.lat ?? location.latitude);
            const lng = Number(location.lng ?? location.lon ?? location.longitude);
            if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
              nextCoords[key] = { lat, lng };
            }
          }
          if (place && (place as any).scrapedAt) {
            const timestamp = new Date((place as any).scrapedAt);
            if (!Number.isNaN(timestamp.valueOf())) {
              if (!freshest || timestamp > freshest) freshest = timestamp;
            }
          }
        });

        setData(arr);
        setVisited(nextVisited);
        setGeoCache(nextCoords);
        setDatasetInfo({ total: arr.length, lastUpdated: freshest });
        setSeen(new Set());
        setCurrentIdx(null);
        setSelectionSource(null);
        setStatusMessage(null);
        setLoadError(null);
      } catch (err: any) {
        if (cancelled) return;
        setData([]);
        setVisited(new Set());
        setGeoCache({});
        setDatasetInfo(null);
        setLoadError(err?.message ?? "Failed to load dataset.");
        setSelectionSource(null);
        setStatusMessage(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadDataset();
    return () => {
      cancelled = true;
    };
  }, [datasetId, datasetMeta.path]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify(Array.from(visited));
    window.localStorage.setItem(storageKey(datasetId), payload);
  }, [visited, datasetId]);

  const availableCount = useMemo(() => {
    return data.reduce((count, place, idx) => {
      return visited.has(placeKey(place, idx)) ? count : count + 1;
    }, 0);
  }, [data, visited]);

  const seenCount = useMemo(() => {
    let count = 0;
    seen.forEach((idx) => {
      const place = data[idx];
      if (!place) return;
      if (visited.has(placeKey(place, idx))) return;
      count += 1;
    });
    return count;
  }, [seen, data, visited]);

  const remainingCount = Math.max(0, availableCount - seenCount);
  const visitedCount = visited.size;
  const allVisited = !loading && data.length > 0 && availableCount === 0;

  const currentCardRef = useRef<HTMLDivElement | null>(null);
  const current = useMemo(
    () => (currentIdx != null && data[currentIdx] ? data[currentIdx] : null),
    [currentIdx, data]
  );

  function handlePickRandom() {
    if (loading || !data.length) return;

    const available: number[] = [];
    const availableSet = new Set<number>();
    for (let i = 0; i < data.length; i++) {
      const place = data[i];
      if (!place) continue;
      if (visited.has(placeKey(place, i))) continue;
      available.push(i);
      availableSet.add(i);
    }
    if (!available.length) {
      setStatusMessage("All places are marked visited. Clear visited to start over.");
      setCurrentIdx(null);
      setSelectionSource(null);
      return;
    }

    let localSeen = new Set<number>();
    seen.forEach((idx) => {
      if (availableSet.has(idx)) localSeen.add(idx);
    });

    if (localSeen.size >= available.length) {
      localSeen = new Set();
    }

    const pool = available.filter((idx) => !localSeen.has(idx));
    const pick = pool[Math.floor(Math.random() * pool.length)];

    setPicking(true);
    localSeen.add(pick);
    setSeen(localSeen);
    setCurrentIdx(pick);
    setSelectionSource("hero");
    setStatusMessage(null);
    if (typeof window !== "undefined") {
      window.setTimeout(() => setPicking(false), 250);
    } else {
      setPicking(false);
    }
  }

  function handleReset() {
    setSeen(new Set());
    setCurrentIdx(null);
    setStatusMessage("Seen list cleared.");
    setSelectionSource(null);
  }

  function handleDatasetChange(nextId: DatasetId) {
    if (nextId === datasetId) return;
    setDatasetId(nextId);
  }

  function focusPlace(idx: number) {
    setCurrentIdx((prev) => {
      if (prev === idx) {
        setSelectionSource(null);
        return null;
      }
      setSelectionSource("list");
      return idx;
    });
    setSeen((prev) => {
      if (prev.has(idx)) return prev;
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }

  function requestLocation() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocationError("Geolocation is not supported in this browser.");
      setLocationStatus("denied");
      return;
    }
    setLocationError(null);
    setLocationStatus("pending");
    setGeolocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeolocating(false);
        setLocationStatus("granted");
      },
      (err) => {
        setLocationError(err?.message ?? "Unable to determine your location.");
        setGeolocating(false);
        setLocationStatus("denied");
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  const currentKey =
    currentIdx != null && data[currentIdx] ? placeKey(data[currentIdx], currentIdx) : null;
  const currentIsVisited = currentKey ? visited.has(currentKey) : false;
  const currentCoords = currentKey ? geoCache[currentKey] : undefined;
  const currentDistance = useMemo(() => {
    if (!currentKey || !userLocation) return null;
    const coords = geoCache[currentKey];
    if (!coords) return null;
    return haversineDistance(userLocation, coords);
  }, [currentKey, userLocation, geoCache]);

  function markVisited() {
    if (currentIdx == null || !currentKey) return;
    if (visited.has(currentKey)) return;
    setVisited((prev) => {
      const next = new Set(prev);
      next.add(currentKey);
      return next;
    });
    setSeen((prev) => {
      const next = new Set(prev);
      next.delete(currentIdx);
      return next;
    });
    setCurrentIdx(null);
    setStatusMessage("Marked as visited.");
    setSelectionSource(null);
  }

  function clearVisited() {
    setVisited(new Set());
    setSeen(new Set());
    setCurrentIdx(null);
    setStatusMessage("Visited places cleared.");
    setSelectionSource(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(storageKey(datasetId));
    }
  }

  const nearbyPlaces = useMemo(() => {
    if (!userLocation) return [];
    const entries = data
      .map((place, idx) => {
        const key = placeKey(place, idx);
        const coords = geoCache[key];
        if (!coords) return null;
        const distanceKm = haversineDistance(userLocation, coords);
        if (distanceKm > 2) return null;
        return { place, idx, distanceKm, key, isVisited: visited.has(key), coords };
      })
      .filter((value): value is {
        place: Place;
        idx: number;
        distanceKm: number;
        key: string;
        isVisited: boolean;
        coords: Coordinates;
      } => value != null)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 30);
    return entries;
  }, [userLocation, data, geoCache, visited]);

  const missingCoordsCount = useMemo(() => {
    return data.reduce((missing, place, idx) => {
      const key = placeKey(place, idx);
      return geoCache[key] ? missing : missing + 1;
    }, 0);
  }, [data, geoCache]);

  const heroMessage = useMemo(() => {
    if (loading) return "Loading dataset…";
    if (loadError) return loadError;
    if (picking) return "Choosing a spot for you…";
    if (!data.length) return "Dataset loaded but contains no places.";
    if (allVisited) return "All places are marked visited. Clear visited to start over.";
    return `${remainingCount} unseen / ${availableCount} unvisited total.`;
  }, [loading, loadError, picking, data.length, allVisited, remainingCount, availableCount]);

  const heroToneClasses = loadError
    ? "text-rose-600"
    : allVisited
      ? "text-amber-600"
      : picking
        ? "text-indigo-600"
        : "text-slate-600";

  const locationSummary = useMemo(() => {
    if (!userLocation) return null;
    if (nearbyPlaces.length > 0) {
      const nearest = nearbyPlaces[0];
      return `Closest: ${nearest.place.title ?? "Unknown"} (${formatDistance(nearest.distanceKm)})`;
    }
    const lat = userLocation.lat.toFixed(3);
    const lng = userLocation.lng.toFixed(3);
    return `Location set (${lat}, ${lng}). No results within 2 km.`;
  }, [userLocation, nearbyPlaces]);

  const locationStatusLabel = useMemo(() => {
    switch (locationStatus) {
      case "pending":
        return "Locating…";
      case "granted":
        return "Location active";
      case "denied":
        return "Location blocked";
      default:
        return "Location off";
    }
  }, [locationStatus]);

  const locationStatusClasses = locationStatus === "granted"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : locationStatus === "denied"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : locationStatus === "pending"
        ? "border-sky-200 bg-sky-50 text-sky-700"
        : "border-slate-200 bg-slate-100 text-slate-500";

  const lastUpdatedLabel = useMemo(() => {
    if (!datasetInfo?.lastUpdated) return null;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(datasetInfo.lastUpdated);
  }, [datasetInfo]);

  const datasetChipClasses = loading
    ? "border-sky-200 bg-sky-50 text-sky-700"
    : loadError
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";

  function Star({ fill }: { fill: number }) {
    const safeFill = Math.max(0, Math.min(1, fill));
    return (
      <span className="relative inline-block text-xl leading-none text-slate-200">
        <span aria-hidden className="block">★</span>
        <span
          aria-hidden
          className="absolute inset-0 overflow-hidden text-slate-600"
          style={{ width: `${safeFill * 100}%` }}
        >
          ★
        </span>
      </span>
    );
  }

  function Stars({ value = 0 }: { value?: number }) {
    const clamped = Math.max(0, Math.min(5, value));
    return (
      <span className="inline-flex gap-0.5 align-middle" aria-label={`${clamped.toFixed(1)} out of 5`}>
        {Array.from({ length: 5 }).map((_, idx) => (
          <Star key={idx} fill={clamped - idx} />
        ))}
      </span>
    );
  }

  function PlaceDetailCard({
    place,
    distanceKm,
    coords,
    isVisited,
    onMarkVisited,
    className,
  }: {
    place: Place;
    distanceKm?: number | null;
    coords?: Coordinates;
    isVisited: boolean;
    onMarkVisited: () => void;
    className?: string;
  }) {
    const distanceLabel = distanceKm != null ? formatDistance(distanceKm) : null;
    return (
      <article
        className={`overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm ${className ?? ""}`}
      >
        <div className="relative h-56 w-full overflow-hidden bg-slate-100">
          {place.imageUrl ? (
            <img
              src={place.imageUrl}
              alt={place.title ?? "location photo"}
              className="h-full w-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-slate-100 via-slate-200 to-slate-100 text-slate-500">
              <span className="text-sm font-medium">No photo yet</span>
              <span className="text-xs">Add one in Google Maps to see it here.</span>
            </div>
          )}
        </div>
        <div className="p-5 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0">
              <h2 className="text-xl sm:text-2xl font-semibold break-words">{place.title ?? "Untitled"}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-600">
                <Stars value={typeof place.totalScore === "number" ? place.totalScore : 0} />
                {typeof place.totalScore === "number" && (
                  <span className="text-sm">{place.totalScore.toFixed(1)}</span>
                )}
                {typeof place.reviewsCount === "number" && (
                  <span className="text-sm">· {place.reviewsCount.toLocaleString()} reviews</span>
                )}
                {distanceLabel && (
                  <span className="text-sm text-slate-500">· {distanceLabel} away</span>
                )}
              </div>
              {place.categoryName && (
                <div className="mt-2">
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700">
                    {place.categoryName}
                  </span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:justify-end">
              <button
                onClick={onMarkVisited}
                className={`text-sm px-3 py-1.5 rounded-lg shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${
                  isVisited
                    ? "cursor-default border border-slate-200 bg-slate-100 text-slate-500"
                    : "border border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700"
                }`}
                disabled={isVisited}
              >
                {isVisited ? "Visited" : "Mark visited"}
              </button>
              {place.website && (
                <a
                  className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                  href={place.website}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Website
                </a>
              )}
              {place.url && (
                <a
                  className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
                  href={place.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open in Maps
                </a>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <InfoRow label="Address" value={fullAddress(place) || "—"} />
            <InfoRow label="Phone" value={place.phone || "—"} />
          </div>
          {coords && (
            <div className="mt-5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="font-medium uppercase tracking-wide">Map preview</span>
                {distanceLabel && <span>{distanceLabel} away</span>}
              </div>
              <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 shadow-sm">
                <iframe
                  title={`Map preview for ${place.title ?? "selected location"}`}
                  src={(() => {
                    const { lat, lng } = coords;
                    const delta = 0.01;
                    const bbox = [
                      lng - delta,
                      lat - delta,
                      lng + delta,
                      lat + delta,
                    ]
                      .map((value) => value.toFixed(5))
                      .join(",");
                    return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${lat.toFixed(5)}%2C${lng.toFixed(5)}`;
                  })()}
                  className="h-60 w-full"
                  loading="lazy"
                  allowFullScreen
                />
              </div>
              <div className="mt-1 text-right text-[11px] text-slate-400">
                © OpenStreetMap contributors
              </div>
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-white to-slate-50 text-slate-800">
      <div className="mx-auto max-w-4xl px-4 pb-24">
        <header className="py-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">I'm Starving</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wide ${datasetChipClasses}`}>
                {loading
                  ? "Loading dataset…"
                  : loadError
                    ? "Dataset error"
                    : `${availableCount.toLocaleString()} places unvisited · ${datasetMeta.label}`}
              </span>
              <span className="text-xs text-slate-500">
                Visited {visitedCount.toLocaleString()} of {datasetInfo?.total?.toLocaleString() ?? data.length.toLocaleString()}
              </span>
              {lastUpdatedLabel && (
                <span className="text-xs text-slate-400">Last updated {lastUpdatedLabel}</span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wide text-slate-400">Choose dataset</span>
              {DATASETS.map((option) => {
                const active = option.id === datasetId;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleDatasetChange(option.id)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold tracking-wide transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 ${
                      active
                        ? "border-indigo-500 bg-indigo-500 text-white shadow-sm"
                        : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:text-indigo-600"
                    }`}
                    disabled={loading && !active}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleReset}
              className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-600 text-sm shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
              disabled={loading || currentIdx == null}
            >
              Reset Seen
            </button>
            <button
              onClick={clearVisited}
              className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-600 text-sm shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
              disabled={loading || visitedCount === 0}
            >
              Clear Visited
            </button>
            <button
              onClick={() => {
                if (typeof window !== "undefined") window.location.reload();
              }}
              className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-600 text-sm shadow-sm transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
            >
              Refresh Dataset
            </button>
          </div>
        </header>

        {/* Hero button */}
        <div className="py-8">
          <div className="flex flex-col items-center justify-center gap-6">
            <div className="flex flex-wrap items-center justify-center gap-4">
              <button
                onClick={handlePickRandom}
                className={`group relative flex w-full max-w-sm flex-col items-center gap-1 rounded-[2.5rem] border border-indigo-500/40 bg-indigo-600 px-10 py-8 text-center text-white shadow-xl shadow-indigo-600/20 transition duration-150 ease-out hover:-translate-y-0.5 hover:bg-indigo-500 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-4 focus-visible:outline-indigo-400 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                  picking ? "animate-pulse" : ""
                }`}
                title="Pick for me!"
                disabled={loading || allVisited}
              >
                <span className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-200 group-hover:text-white">
                  Tonight's pick
                </span>
                <span className="text-2xl sm:text-3xl font-semibold">I'm starving</span>
                <span className="text-sm text-indigo-100 group-hover:text-white/90">Tap to decide your next bite</span>
                <span className="absolute -inset-1 -z-10 rounded-[3rem] bg-gradient-to-r from-amber-400/40 via-fuchsia-500/30 to-indigo-500/40 opacity-0 blur-xl transition group-hover:opacity-80" />
              </button>
              <button
                onClick={requestLocation}
                className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={loading || geolocating}
              >
                {geolocating ? "Locating…" : userLocation ? "Update location" : "Find near me"}
              </button>
            </div>
            {(userLocation || locationStatus !== "idle") && (
              <div className="flex items-center justify-center">
                <span className={`mt-2 inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wide ${locationStatusClasses}`}>
                  {locationStatusLabel}
                </span>
              </div>
            )}
            <p className={`text-sm text-center ${heroToneClasses}`} aria-live="polite">
              {heroMessage}
            </p>
            {locationError && (
              <p className="text-xs text-rose-500">
                {locationError}
              </p>
            )}
            {userLocation && (
              <p className="text-xs text-slate-500">
                {locationSummary}
              </p>
            )}
            {userLocation && missingCoordsCount > 0 && nearbyPlaces.length === 0 && (
              <p className="text-xs text-slate-500">
                Coordinates missing for {missingCoordsCount} place{missingCoordsCount === 1 ? "" : "s"}.
              </p>
            )}
            {loadError && (
              <p className="text-xs text-rose-500">
                {`Fix \`public${datasetMeta.path}\` then refresh to reload the data automatically.`}
              </p>
            )}
          </div>
        </div>

        {statusMessage && (
          <div
            role="status"
            aria-live="polite"
            className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 shadow-sm"
          >
            {statusMessage}
          </div>
        )}

        {/* Result card */}
        {current && selectionSource !== "list" && (
          <div
            ref={currentCardRef}
            className="mt-2 animate-in fade-in zoom-in duration-300"
          >
            <PlaceDetailCard
              place={current}
              distanceKm={currentDistance}
              coords={currentCoords}
              isVisited={currentIsVisited}
              onMarkVisited={markVisited}
            />
          </div>
        )}

        {userLocation && nearbyPlaces.length > 0 && (
          <section className="mt-12">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-700">Nearby picks</h2>
              <span className="text-xs uppercase tracking-wide text-slate-400">
                Within 2 km · showing up to 30
              </span>
            </div>
            <div className="mt-4 grid gap-3">
              {nearbyPlaces.slice(0, 30).map(({ place, idx, distanceKm, isVisited, key, coords }) => {
                const expanded = currentIdx === idx && selectionSource === "list";
                return (
                  <div key={key}>
                    <button
                      type="button"
                      onClick={() => focusPlace(idx)}
                      aria-expanded={expanded}
                      className={`w-full text-left rounded-2xl border px-4 py-3 shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400 hover:border-indigo-300 hover:shadow ${
                        expanded ? "border-indigo-300 bg-indigo-50/80" : "border-slate-200 bg-white"
                      } ${isVisited && !expanded ? "opacity-70" : ""}`}
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <div className="min-w-0">
                          <div className="font-medium text-slate-800 break-words">{place.title ?? "Untitled"}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                            <span className="break-words sm:max-w-[16rem]">
                              {buildAddress(place) || "Address unavailable"}
                            </span>
                            {place.categoryName && (
                              <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] uppercase tracking-wide text-slate-600">
                                {place.categoryName}
                              </span>
                            )}
                            {isVisited && (
                              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-600">
                                Visited
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1 sm:flex-col sm:items-end">
                          <span className="rounded-full bg-indigo-600/10 px-3 py-1 text-xs font-semibold text-indigo-700">
                            {formatDistance(distanceKm)}
                          </span>
                          {typeof place.totalScore === "number" && (
                            <span className="text-[11px] text-slate-500">Rating {place.totalScore.toFixed(1)}</span>
                          )}
                        </div>
                      </div>
                    </button>
                    {expanded && (
                      <div className="mt-3">
                        <PlaceDetailCard
                          place={place}
                          distanceKm={distanceKm}
                          coords={coords}
                          isVisited={isVisited}
                          onMarkVisited={markVisited}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Empty state helper */}
        {!current && (
          <div className="mt-4 text-center text-slate-500">
            Tip: Use the dataset controls above to refresh or update your places.
          </div>
        )}
      </div>
    </div>
  );
}

function fullAddress(p: Place) {
  const bits = [p.street, p.city, p.state ?? undefined, p.countryCode].filter(Boolean);
  return bits.join(", ");
}

function InfoRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm text-slate-800 break-words">{value || "—"}</div>
    </div>
  );
}
