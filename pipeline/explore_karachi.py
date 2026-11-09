"""
PathWise - Step 1 (v2): explore and clean the Kaggle Karachi crime dataset.

Usage (inside your activated .venv):
    python explore_karachi.py karachi_crime.csv

Outputs:
    karachi_incidents_clean.csv  - cleaned rows with numeric severity
    and a printed summary (row counts, dates, crime types, severity,
    plus checks that help you judge whether the data is real or synthetic).
"""
import sys
import pandas as pd
import os

# Rough Karachi bounding box
LAT_MIN, LAT_MAX = 24.70, 25.25
LON_MIN, LON_MAX = 66.80, 67.50


def main(path):
    df = pd.read_csv(path)
    print(f"Total rows: {len(df)}")

    # --- clean -----------------------------------------------------------
    df["Latitude"] = pd.to_numeric(df["Latitude"], errors="coerce")
    df["Longitude"] = pd.to_numeric(df["Longitude"], errors="coerce")
    # dates look like 01-01-2020 (day-month-year)
    df["date"] = pd.to_datetime(df["Date"], format="%d-%m-%Y", errors="coerce")

    before = len(df)
    df = df.dropna(subset=["Latitude", "Longitude", "date"])
    df = df[(df["Latitude"] != 0) & (df["Longitude"] != 0)]
    print(f"After dropping bad coords/dates: {len(df)} (removed {before - len(df)})")

    in_box = df["Latitude"].between(LAT_MIN, LAT_MAX) & df["Longitude"].between(LON_MIN, LON_MAX)
    print(f"Inside Karachi bounding box: {in_box.sum()} (outside: {(~in_box).sum()})")
    df = df[in_box].copy()

    dupes = df.duplicated(subset=["Case_ID"]).sum()
    print(f"Duplicate Case_IDs: {dupes}")
    df = df.drop_duplicates(subset=["Case_ID"])

    # --- summary ---------------------------------------------------------
    print("\n=== SUMMARY ===")
    print(f"Usable rows: {len(df)}")
    print(f"Date range:  {df['date'].min().date()} -> {df['date'].max().date()}")

    print("\nRows per year:")
    print(df["date"].dt.year.value_counts().sort_index().to_string())

    print("\nCrime types:")
    print(df["Crime_Type"].value_counts().to_string())

    print("\nSeverity values (you must map these to numbers):")
    print(df["Severity"].value_counts(dropna=False).to_string())

    print("\nVictim gender:")
    print(df["Victim_Gender"].value_counts(dropna=False).to_string())

    print("\nTop 15 areas by incident count:")
    print(df["Area"].value_counts().head(15).to_string())

    # --- is it synthetic? -----------------------------------------------
    print("\n=== SYNTHETIC-DATA CHECKS ===")
    # Real incidents cluster unevenly. Synthetic data is often very uniform.
    per_month = df.groupby(df["date"].dt.to_period("M")).size()
    print(f"Incidents per month: min={per_month.min()}, max={per_month.max()}, "
          f"std/mean={per_month.std() / per_month.mean():.3f} (very low = suspiciously uniform)")

    hour = df["Hour_24"].value_counts(normalize=True).sort_index()
    print(f"Hour-of-day share: max={hour.max():.3f}, min={hour.min():.3f} "
          f"(near 1/24 = 0.042 each means uniform)")

    # Coordinates scattered randomly around each area centre?
    spread = df.groupby("Area")[["Latitude", "Longitude"]].std().mean()
    print(f"Avg coordinate spread within an area: lat {spread['Latitude']:.4f}, "
          f"lon {spread['Longitude']:.4f} (~0.01 deg = ~1 km)")

    sev_map = {"low": 1, "medium": 2, "moderate": 2, "high": 3, "critical": 4}
    sev_num = df["Severity"].astype(str).str.strip().str.lower().map(sev_map)
    if sev_num.isna().any():
        print(f"\nNOTE: {sev_num.isna().sum()} rows have a severity not in {list(sev_map)}. "
              "Edit sev_map in the script to match the values printed above.")
    df["severity_num"] = sev_num

    out = df.rename(columns={
        "Latitude": "lat", "Longitude": "lon",
        "Crime_Type": "crime_type", "Severity": "severity",
        "Area": "area", "Hour_24": "hour", "Victim_Gender": "victim_gender",
    })[["Case_ID", "date", "hour", "lat", "lon", "area", "crime_type",
        "severity", "severity_num", "victim_gender"]]
    os.makedirs("data", exist_ok=True)
    out.to_csv("data/karachi_incidents_clean.csv", index=False)
    print("\nSaved data/karachi_incidents_clean.csv")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python explore_karachi.py karachi_crime.csv")
    else:
        main(sys.argv[1])
