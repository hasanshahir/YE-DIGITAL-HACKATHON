"""
PathWise safety guide  -  GET /safety-guide  and  GET /safety-guide/{section_id}

Static, hand-written content served as JSON so the frontend (and anything else) can read it.
Wire it into api/main.py with two lines:

    from api.safety_guide import router as safety_guide_router
    app.include_router(safety_guide_router)
"""
from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["safety-guide"])

GUIDE = {
    "title": "Safety guide",
    "intro": "Practical tips for getting around Karachi, and how to read PathWise's safety scores.",
    "emergency": [
        {"name": "Police (Madadgar)", "number": "15", "note": "Police emergency"},
        {"name": "Rescue", "number": "1122", "note": "Sindh Emergency Rescue Service"},
        {"name": "Edhi ambulance", "number": "115", "note": "Ambulance and welfare"},
        {"name": "Fire brigade", "number": "16", "note": "Fire emergencies"},
    ],
    "sections": [
        {"id": "before-you-go", "title": "Before you leave", "tips": [
            "Compare routes in PathWise first. A slightly longer route can carry much less risk.",
            "Share your trip and expected arrival time with someone you trust.",
            "Charge your phone and carry only what you need.",
            "At night, prefer main, well-lit roads when the extra distance is small.",
        ]},
        {"id": "driving-riding", "title": "Driving and riding", "tips": [
            "Keep doors locked and windows up at signals and in slow traffic.",
            "Keep phones, bags and cash out of sight, not on the dashboard, seat or tank bag.",
            "Avoid stopping in empty or poorly lit stretches. If you must stop, choose a busy spot.",
            "Riders: avoid using your phone at traffic stops. Snatchers often target visible phones.",
        ]},
        {"id": "on-foot", "title": "On foot", "tips": [
            "Stay on busy, lit streets, even if a side street is shorter.",
            "Keep your phone away while walking near the road, and keep one earbud out.",
            "Carry valuables in a front pocket or a bag worn across your body.",
        ]},
        {"id": "women", "title": "Women's safety", "tips": [
            "Turn on Women's safety mode in PathWise. It gives extra weight to harassment and snatching risk.",
            "Share your live location with a trusted contact during the trip.",
            "Check the vehicle and driver details before getting into a ride.",
            "If you feel followed, head for a shop, petrol station or busy place and call for help.",
        ]},
        {"id": "if-something-happens", "title": "If something happens", "tips": [
            "Your safety comes first. Property can be replaced, so do not resist an armed demand.",
            "Move to a safe, busy place, then call 15 or 1122 if anyone is hurt or in danger.",
            "Note the time, place, vehicle and descriptions while they are fresh.",
            "Report it to the police. A PathWise report helps other users but is not a police report.",
        ]},
        {"id": "reading-scores", "title": "How to read PathWise scores", "tips": [
            "The safety percentage compares the routes shown for this trip. It is not a guarantee of safety.",
            "Exposure labels (lower, moderate, higher) come from historical incident data per road segment.",
            "The current dataset is synthetic demo data. It shows how the system works, not real Karachi crime.",
            "Slide towards Safest for lower exposure, or towards Fastest for shorter trips.",
            "Reports you submit update the affected road straight away. They are unverified.",
        ]},
    ],
    "disclaimer": "Safety information is general guidance, not a guarantee. Emergency numbers were checked against "
                  "public sources, so confirm them locally. In an emergency, call the authorities first.",
}


@router.get("/safety-guide")
def safety_guide():
    return GUIDE


@router.get("/safety-guide/{section_id}")
def safety_guide_section(section_id: str):
    for s in GUIDE["sections"]:
        if s["id"] == section_id:
            return s
    raise HTTPException(status_code=404, detail="Unknown safety guide section.")
